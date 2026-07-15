const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin, optionalAuth } = require('../../middleware/auth');

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
// GET /api/products/same-day?dong=XXX
// 고객 배송지 '동' 기준 당일배송 가능 상품만 노출 (MD2 지역매칭)
//  - 해당 동을 담당하는 활성 벤더의 is_same_day 상품만 반환
//  - 담당 벤더/권역 없으면 빈 배열(= 배송불가 숨김)
// ====================================================

router.get('/same-day', optionalAuth, async (req, res) => {
  try {
    const dong = (req.query.dong || '').trim();
    if (!dong) return res.json({ ok: true, dong: '', products: [], reason: 'no_dong' });

    // 1) 권역(delivery_zones + vendor_zones) 기반 담당 벤더
    let zoneVendorIds = [];
    const { data: zones } = await supabase
      .from('delivery_zones').select('id').eq('dong', dong);
    const zoneIds = (zones || []).map(z => z.id);
    if (zoneIds.length) {
      const { data: vz } = await supabase
        .from('vendor_zones').select('vendor_id').in('zone_id', zoneIds);
      zoneVendorIds = (vz || []).map(v => v.vendor_id);
    }

    // 2) 폴백: 권역 매핑이 없어도 벤더 자체 주소(동)가 일치하면 노출
    const { data: dongVendors } = await supabase
      .from('vendors').select('id').eq('dong', dong);
    const dongVendorIds = (dongVendors || []).map(v => v.id);

    const vendorIds = [...new Set([...zoneVendorIds, ...dongVendorIds])];
    if (!vendorIds.length) return res.json({ ok: true, dong, products: [], reason: 'no_vendor' });

    // 3) 활성 벤더만
    const { data: vs } = await supabase
      .from('vendors').select('id, vendor_name').in('id', vendorIds).eq('is_active', true);
    const activeIds = (vs || []).map(v => v.id);
    if (!activeIds.length) return res.json({ ok: true, dong, products: [], reason: 'no_active_vendor' });
    const vendorNameMap = Object.fromEntries((vs || []).map(v => [v.id, v.vendor_name]));

    // 4) 해당 벤더의 당일배송 상품 (재고>0, 활성)
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .in('vendor_id', activeIds)
      .eq('is_same_day', true)
      .eq('is_active', true)
      .gt('stock', 0)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const formatted = (products || []).map(p => ({
      ...p,
      category_name: p.category,
      same_day: true,
      vendor_name: vendorNameMap[p.vendor_id] || null
    }));

    res.json({ ok: true, dong, products: formatted });
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
