const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin, optionalAuth } = require('../../middleware/auth');
const { kakaoGeocode, haversineKm } = require('../../lib/geocode');

// ── 상품 목록 캐시 (60초 TTL, 관리자 우회) ───────────────
const _pc = new Map();
function _pcGet(k) {
  const e = _pc.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { _pc.delete(k); return null; }
  return e.data;
}
function _pcSet(k, d) { _pc.set(k, { data: d, exp: Date.now() + 60000 }); }
function _pcClear() { _pc.clear(); }

// ====================================================
// CORS
// ====================================================

const allowedOrigins = [
  'https://smartpd-eco.github.io',
  'https://meatmall.vercel.app'
];

router.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// ====================================================
// GET /api/products
// ====================================================

router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      category,
      category_id,
      sort = 'created_at',
      order = 'desc',
      page = 1,
      limit = 20,
      search,
      is_subscribe
    } = req.query;

    const isAdmin = !!req.user?.is_admin;
    const cacheKey = isAdmin ? null : `list:${JSON.stringify(req.query)}`;
    if (cacheKey) {
      const cached = _pcGet(cacheKey);
      if (cached) {
        res.set('Cache-Control', 'public, max-age=60');
        return res.json(cached);
      }
    }

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 20;

    let query = supabase
      .from('products')
      .select('*', { count: 'exact' })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);

    // 일반 사용자는 활성 상품만 조회
    if (!isAdmin) {
      query = query.eq('is_active', true);
    }

    if (category_id) query = query.eq('category_id', Number(category_id));
    else if (category) query = query.eq('category', category);
    if (is_subscribe === 'true' || is_subscribe === true) query = query.eq('is_subscribe', true);
    if (search) query = query.ilike('name', `%${search}%`);

    const allowedSorts = ['created_at', 'price', 'name', 'stock'];

    if (sort === 'price_asc') {
      query = query.order('price', { ascending: true });
    } else if (sort === 'price_desc') {
      query = query.order('price', { ascending: false });
    } else if (allowedSorts.includes(sort)) {
      query = query.order(sort, { ascending: order === 'asc' });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    const { data: products, count, error } = await query;

    if (error) throw error;

    const formatted = (products || []).map(p => ({
      ...p,
      category_name: p.category
    }));

    const result = { ok: true, products: formatted, total: count, page: pageNum, limit: limitNum };
    if (cacheKey) {
      _pcSet(cacheKey, result);
      res.set('Cache-Control', 'public, max-age=60');
    }
    res.json(result);
  } catch (err) {
    console.error('[products/get]', err);

    res.status(500).json({
      error: err.message || '상품 조회 중 오류가 발생했습니다',
      details: err
    });
  }
});

// ====================================================
// GET /api/products/best
// ====================================================

router.get('/best', async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(8);

    if (error) throw error;

    res.json({
      ok: true,
      products: products || []
    });
  } catch (err) {
    console.error('[products/best]', err);

    res.status(500).json({
      error: err.message || '베스트 상품 조회 오류',
      details: err
    });
  }
});

// ====================================================
// GET /api/products/same-day?dong=XXX&address_id=YYY
// 고객 배송지 기준 당일배송 매칭 (설계서 규칙 반영)
//  판정: 동/권역 1차 → 벤더 당일배송 on + 마감 전 + 일일한도 미초과
//        → (좌표 있으면) 직선 반경컷 → 재고·당일수량 → 랭킹(동우선·priority·평점)
//  좌표(거리컷)는 KAKAO_REST_API_KEY 설정 시 자동 활성화, 없으면 건너뜀
// ====================================================

router.get('/same-day', optionalAuth, async (req, res) => {
  try {
    const dong = (req.query.dong || '').trim();
    const addressId = req.query.address_id;
    if (!dong) return res.json({ ok: true, dong: '', products: [], reason: 'no_dong' });

    // ── 회원 배송지 좌표 (있으면 반경컷에 사용, 없으면 생략) ──
    let userCoords = null;
    if (addressId && req.user?.sub) {
      const { data: addr } = await supabase
        .from('addresses').select('id, address1, address2, latitude, longitude')
        .eq('id', addressId).eq('user_id', req.user.sub).single();
      if (addr) {
        if (addr.latitude != null && addr.longitude != null) {
          userCoords = { lat: addr.latitude, lng: addr.longitude };
        } else {
          const geo = await kakaoGeocode(addr.address1);
          if (geo) {
            userCoords = geo;
            await supabase.from('addresses')
              .update({ latitude: geo.lat, longitude: geo.lng, geocoded_at: new Date().toISOString() })
              .eq('id', addr.id);
          }
        }
      }
    }

    // ── 1차 후보: 권역(vendor_zones) ∪ 동 일치 벤더 ──
    let zonePri = {}; // vendor_id -> min priority
    const { data: zones } = await supabase.from('delivery_zones').select('id').eq('dong', dong);
    const zoneIds = (zones || []).map(z => z.id);
    if (zoneIds.length) {
      const { data: vz } = await supabase
        .from('vendor_zones').select('vendor_id, priority').in('zone_id', zoneIds);
      (vz || []).forEach(v => {
        const cur = zonePri[v.vendor_id];
        zonePri[v.vendor_id] = cur == null ? (v.priority ?? 1) : Math.min(cur, v.priority ?? 1);
      });
    }
    const { data: dongVendors } = await supabase.from('vendors').select('id').eq('dong', dong);
    (dongVendors || []).forEach(v => { if (zonePri[v.id] == null) zonePri[v.id] = 99; });

    const candIds = Object.keys(zonePri).map(Number);
    if (!candIds.length) return res.json({ ok: true, dong, products: [], reason: 'no_vendor' });

    // ── 후보 벤더 상세 ──
    const { data: vendors } = await supabase
      .from('vendors')
      .select('id, vendor_name, dong, address, lat, lng, score, is_active, same_day_enabled, same_day_radius_km, same_day_cutoff, daily_order_limit')
      .in('id', candIds);

    // KST 현재 시각/일자
    const nowKst = new Date(Date.now() + 9 * 3600 * 1000);
    const hhmmss = nowKst.toISOString().slice(11, 19);      // 'HH:MM:SS'
    const todayKst = nowKst.toISOString().slice(0, 10);      // 'YYYY-MM-DD'

    const reasons = { closed: 0, limit: 0, out_of_range: 0, disabled: 0 };
    const eligible = [];

    for (const v of (vendors || [])) {
      if (!v.is_active || v.same_day_enabled === false) { reasons.disabled++; continue; }

      // 마감시간
      const cutoff = (v.same_day_cutoff || '14:00:00').slice(0, 8).padEnd(8, ':00');
      if (hhmmss >= cutoff) { reasons.closed++; continue; }

      // 일일 주문한도
      const { count: todayCnt } = await supabase
        .from('vendor_orders').select('id', { count: 'exact', head: true })
        .eq('vendor_id', v.id).neq('status', 'cancelled').gte('created_at', todayKst);
      if ((todayCnt || 0) >= (v.daily_order_limit || 50)) { reasons.limit++; continue; }

      // 거리 반경컷 (좌표 있을 때만)
      let km = null;
      if (userCoords) {
        let vlat = v.lat, vlng = v.lng;
        if ((vlat == null || vlng == null) && v.address) {
          const g = await kakaoGeocode(v.address);
          if (g) { vlat = g.lat; vlng = g.lng; await supabase.from('vendors').update({ lat: g.lat, lng: g.lng }).eq('id', v.id); }
        }
        if (vlat != null && vlng != null) {
          km = haversineKm(userCoords.lat, userCoords.lng, vlat, vlng);
          if (km > Number(v.same_day_radius_km || 8)) { reasons.out_of_range++; continue; }
        }
      }

      eligible.push({
        id: v.id, name: v.vendor_name,
        dongExact: v.dong === dong ? 0 : 1,
        priority: zonePri[v.id] ?? 99,
        score: Number(v.score || 0),
        km
      });
    }

    if (!eligible.length) {
      // 대표 사유 결정 (거리 > 마감 > 한도 순)
      let reason = 'no_vendor';
      if (reasons.out_of_range) reason = 'out_of_range';
      else if (reasons.closed) reason = 'closed';
      else if (reasons.limit) reason = 'limit';
      return res.json({ ok: true, dong, products: [], reason });
    }

    // ── 랭킹: 동 우선 → priority → 평점 → 거리 ──
    eligible.sort((a, b) =>
      a.dongExact - b.dongExact ||
      a.priority - b.priority ||
      b.score - a.score ||
      ((a.km ?? 1e9) - (b.km ?? 1e9))
    );
    const rank = Object.fromEntries(eligible.map((e, i) => [e.id, i]));
    const nameMap = Object.fromEntries(eligible.map(e => [e.id, e.name]));
    const kmMap = Object.fromEntries(eligible.map(e => [e.id, e.km]));

    // ── 당일배송 상품 (재고>0, 당일수량>0) ──
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .in('vendor_id', eligible.map(e => e.id))
      .eq('is_same_day', true)
      .eq('is_active', true)
      .gt('stock', 0)
      .gt('same_day_qty', 0);
    if (error) throw error;

    const formatted = (products || []).map(p => ({
      ...p,
      category_name: p.category,
      same_day: true,
      vendor_name: nameMap[p.vendor_id] || null,
      distance_km: kmMap[p.vendor_id] != null ? Math.round(kmMap[p.vendor_id] * 10) / 10 : null
    })).sort((a, b) => (rank[a.vendor_id] ?? 99) - (rank[b.vendor_id] ?? 99));

    res.json({ ok: true, dong, products: formatted, reason: formatted.length ? null : 'no_stock' });
  } catch (err) {
    console.error('[products/same-day]', err);
    res.status(500).json({ error: err.message || '당일배송 상품 조회 오류' });
  }
});

// ====================================================
// GET /api/products/:id
// ====================================================

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', req.params.id)
      .eq('is_active', true)
      .single();

    if (error || !product) {
      return res.status(404).json({
        error: '상품을 찾을 수 없습니다'
      });
    }

    res.json({
      ok: true,
      product: { ...product, category_name: product.category }
    });
  } catch (err) {
    console.error('[products/id]', err);

    res.status(500).json({
      error: err.message || '상품 상세 조회 오류',
      details: err
    });
  }
});

// ====================================================
// POST /api/products
// ====================================================

router.post('/', requireAdmin, async (req, res) => {
  try {
    console.log('POST BODY =>', req.body);

    const {
      name,
      description,
      category,
      category_id,
      source_type,
      origin,
      weight_g,
      price,
      origin_price,
      stock,
      min_stock,
      expiry_days,
      is_subscribe,
      haccp,
      emoji,
      thumbnail_url
    } = req.body;

    if (!name || (!category && !category_id) || price === undefined || price === null || price === '') {
      return res.status(400).json({
        error: '이름, 카테고리, 가격은 필수입니다'
      });
    }

    const { data: product, error } = await supabase
      .from('products')
      .insert({
        name,
        description,
        category,
        category_id: category_id ? Number(category_id) : null,
        source_type,
        origin,
        weight_g: Number(weight_g) || 0,
        price: Number(price),
        origin_price: Number(origin_price) || 0,
        stock: Number(stock) || 0,
        min_stock: Number(min_stock) || 10,
        expiry_days: Number(expiry_days) || 0,
        is_subscribe: !!is_subscribe,
        haccp: !!haccp,
        emoji: emoji || '🥩',
        thumbnail_url,
        is_active: true
      })
      .select()
      .single();

    if (error) throw error;

    _pcClear();
    res.status(201).json({
      ok: true,
      product
    });
  } catch (err) {
    console.error('========== PRODUCT INSERT ERROR ==========');
    console.error(err);
    console.error('=========================================');

    res.status(500).json({
      error: err.message || '상품 등록 오류',
      details: err
    });
  }
});

// ====================================================
// PATCH /api/products/:id
// ====================================================

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from('products')
      .update({
        ...req.body,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    _pcClear();
    res.json({
      ok: true,
      product
    });
  } catch (err) {
    console.error('[products/patch]', err);

    res.status(500).json({
      error: err.message || '상품 수정 오류',
      details: err
    });
  }
});

// ====================================================
// DELETE /api/products/:id
// ====================================================

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('products')
      .update({
        is_active: false
      })
      .eq('id', req.params.id);

    if (error) throw error;

    _pcClear();
    res.json({
      ok: true
    });
  } catch (err) {
    console.error('[products/delete]', err);

    res.status(500).json({
      error: err.message || '상품 삭제 오류',
      details: err
    });
  }
});

module.exports = router;
