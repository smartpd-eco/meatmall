// ════════════════════════════════════════════════════
//  행사기반 수요예측·선제 재고이전 (관리자)
//  공공 행사 수집 → 반경 매장에 재고 이동 요청 생성 → 기존 이전 추천으로 연결.
// ════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');
const { haversineKm, kakaoGeocode } = require('../../lib/geocode');
const { fetchFestivals } = require('../../lib/event-api');
const { inferDemand } = require('../../lib/event-demand');

router.use(requireAdmin);

// 활성 벤더 좌표 로드(+ 좌표 없으면 주소로 자동 지오코딩 후 저장)
async function loadVendorCoords() {
  const { data: vs } = await supabase.from('vendors').select('id, vendor_name, address, lat, lng, is_active');
  const out = [];
  for (const v of (vs || [])) {
    if (!v.is_active) continue;
    let lat = v.lat, lng = v.lng;
    if ((lat == null || lng == null) && v.address) {
      const g = await kakaoGeocode(v.address);
      if (g) {
        lat = g.lat; lng = g.lng;
        await supabase.from('vendors').update({ lat, lng }).eq('id', v.id); // 다음부터 재변환 안 함
      }
    }
    if (lat != null && lng != null) out.push({ id: v.id, vendor_name: v.vendor_name, lat, lng });
  }
  return out;
}

// 행사 기간(일). start~end 없으면 매우 크게 잡아 '상설'로 간주.
function eventSpanDays(ev) {
  if (!ev.start_date || !ev.end_date) return 9999;
  const s = new Date(ev.start_date), e = new Date(ev.end_date);
  return Math.round((e - s) / 86400000) + 1;
}

// 상품목록 + 매장별 재고 인덱스(현재고>0)
async function buildStockIndex() {
  const [{ data: prods }, { data: inv }] = await Promise.all([
    supabase.from('products').select('id, name'),
    supabase.from('vendor_inventory').select('product_id, current_stock, vendors(vendor_name, lat, lng)')
  ]);
  const stockByProduct = new Map();
  for (const r of (inv || [])) {
    const q = Number(r.current_stock) || 0;
    if (q <= 0) continue;
    const v = r.vendors || {};
    if (!stockByProduct.has(r.product_id)) stockByProduct.set(r.product_id, []);
    stockByProduct.get(r.product_id).push({ vendor_name: v.vendor_name || '매장', lat: v.lat, lng: v.lng, qty: q });
  }
  return { products: prods || [], stockByProduct };
}

// 추천 부위(cuts) → 매칭 상품 키워드 추출
function cutKeywords(cuts) {
  const set = new Set();
  for (const c of (cuts || [])) {
    const base = String(c).replace(/\(.*?\)/g, ' ').replace(/양념|수제|훈제/g, ' ');
    for (const tok of base.split(/\s+/)) if (tok.length >= 2) set.add(tok);
    if (/닭/.test(c)) set.add('닭');
    if (/오리/.test(c)) set.add('오리');
    if (/소시지|소세지/.test(c)) set.add('소시지');
    if (/갈비/.test(c)) set.add('갈비');
  }
  return [...set];
}

// 재고 기준 추천 상품 선정 + 재고 위치
function pickRecommendation(ev, demand, index) {
  const keys = cutKeywords(demand.cuts);
  const cands = index.products.filter(p => keys.some(k => (p.name || '').includes(k)));
  if (!cands.length) return { product_id: null, product_name: null, in_stock: false, locations: [] };

  const evLat = ev.lat, evLng = ev.lng;
  const locsFor = (pid) => {
    const arr = (index.stockByProduct.get(pid) || []).map(s => ({
      name: s.vendor_name, qty: s.qty,
      km: (evLat != null && s.lat != null) ? Math.round(haversineKm(evLat, evLng, s.lat, s.lng) * 10) / 10 : null
    }));
    arr.sort((a, b) => (a.km == null ? 1e9 : a.km) - (b.km == null ? 1e9 : b.km) || b.qty - a.qty);
    return arr;
  };

  // 재고 있는 후보 우선(가장 가까운 재고 매장 기준), 없으면 이름매칭 첫 후보
  let best = null, bestScore = Infinity;
  for (const p of cands) {
    const locs = locsFor(p.id);
    if (!locs.length) continue;
    const nearKm = locs[0].km == null ? 1e6 : locs[0].km;
    if (nearKm < bestScore) { bestScore = nearKm; best = { p, locs }; }
  }
  if (best) return { product_id: best.p.id, product_name: best.p.name, in_stock: true, locations: best.locs.slice(0, 3) };
  return { product_id: cands[0].id, product_name: cands[0].name, in_stock: false, locations: [] };
}

// 공공 API에서 행사 수집 → events 저장
router.post('/sync', async (req, res) => {
  try {
    const r = await fetchFestivals(Number(req.query.days) || 30);
    if (!r.ok) return res.json({ ok: false, reason: r.reason, synced: 0,
      message: r.reason === 'no_key' ? 'EVENT_API_KEY(공공데이터포털 서비스키)가 설정되지 않았습니다.' : '행사 수집 실패: ' + r.reason });
    let n = 0;
    for (const e of r.items) {
      const { error } = await supabase.from('events').upsert({
        ext_id: e.ext_id, title: e.title, lat: e.lat, lng: e.lng, addr: e.addr,
        start_date: e.start_date, end_date: e.end_date, source: 'tourapi'
      }, { onConflict: 'ext_id' });
      if (!error) n++;
    }
    res.json({ ok: true, synced: n, fetched: r.items.length });
  } catch (err) { console.error('[events/sync]', err); res.status(500).json({ error: err.message || '수집 오류' }); }
});

// 다가오는 행사 목록
//  - radius_km(기본 30): 등록 벤더 중 하나라도 이 반경 내인 행사만 노출
//  - max_days(기본 14): 기간 max_days 이하의 단기 행사만(연중·상설 제외)
router.get('/', async (req, res) => {
  try {
    const R = Math.max(1, Number(req.query.radius_km) || 30);
    const MAXD = Math.max(1, Number(req.query.max_days) || 14);
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase.from('events').select('*').gte('end_date', today).order('start_date', { ascending: true }).limit(500);
    const vendors = await loadVendorCoords();
    const total = (data || []).length;

    let events = (data || []).map(ev => {
      // 가장 가까운 벤더·거리
      let nearest = null, nearKm = Infinity;
      if (ev.lat != null && ev.lng != null) {
        for (const v of vendors) {
          const km = haversineKm(ev.lat, ev.lng, v.lat, v.lng);
          if (km < nearKm) { nearKm = km; nearest = v; }
        }
      }
      return { ...ev, span_days: eventSpanDays(ev),
        nearest_store: nearest ? nearest.vendor_name : null,
        nearest_km: nearest ? Math.round(nearKm * 10) / 10 : null,
        demand: inferDemand(ev) };
    });

    // 필터: 단기 행사 + 반경 내
    const filtered = events
      .filter(e => e.span_days <= MAXD)
      .filter(e => e.nearest_km != null && e.nearest_km <= R)
      .sort((a, b) => a.nearest_km - b.nearest_km);

    // 재고 기준 추천 상품 부착(노출 대상만)
    const index = await buildStockIndex();
    for (const e of filtered) e.rec = pickRecommendation(e, e.demand, index);

    res.json({ ok: true, events: filtered, total, shown: filtered.length,
      radius_km: R, max_days: MAXD, vendors: vendors.length,
      note: vendors.length === 0 ? '반경 판정 기준이 될 벤더 좌표가 없습니다(주소 등록/지오코딩 필요).' : undefined });
  } catch (err) { console.error('[events/list]', err); res.status(500).json({ error: '조회 오류' }); }
});

// 행사 → 반경 내 매장에 선제 재고 이동 요청 생성 (이전 추천으로 연결)
router.post('/:id/plan', async (req, res) => {
  try {
    const { product_id, base_qty, radius_km } = req.body || {};
    const R = Number(radius_km) || 10, qty = Number(base_qty) || 0;
    if (!product_id || qty <= 0) return res.status(400).json({ error: '품목·수량은 필수입니다' });
    const { data: ev } = await supabase.from('events').select('*').eq('id', req.params.id).single();
    if (!ev || ev.lat == null) return res.status(404).json({ error: '행사 좌표가 없습니다' });
    const { data: vs } = await supabase.from('vendors').select('id, vendor_name, lat, lng, is_active');
    const near = (vs || []).filter(v => v.is_active && v.lat != null && v.lng != null && haversineKm(ev.lat, ev.lng, v.lat, v.lng) <= R);
    if (!near.length) return res.json({ ok: true, created: 0, message: '행사 반경 내 매장이 없습니다' });
    const { data: prod } = await supabase.from('products').select('name').eq('id', product_id).single();
    let created = 0;
    for (const v of near) {
      const { error } = await supabase.from('stock_transfer_requests').insert({
        requester_vendor_id: v.id, product_id, item_name: prod ? prod.name : null, qty,
        note: `행사 수요예측: ${ev.title} (${ev.start_date || ''})`, status: 'open', created_by: 'event'
      });
      if (!error) created++;
    }
    res.json({ ok: true, created, stores: near.length, event: ev.title });
  } catch (err) { console.error('[events/plan]', err); res.status(500).json({ error: err.message || '요청 생성 오류' }); }
});

module.exports = router;
