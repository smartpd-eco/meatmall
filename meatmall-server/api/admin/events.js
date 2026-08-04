// ════════════════════════════════════════════════════
//  행사기반 수요예측·선제 재고이전 (관리자)
//  공공 행사 수집 → 반경 매장에 재고 이동 요청 생성 → 기존 이전 추천으로 연결.
// ════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');
const { haversineKm } = require('../../lib/geocode');
const { fetchFestivals } = require('../../lib/event-api');

router.use(requireAdmin);

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
router.get('/', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase.from('events').select('*').gte('end_date', today).order('start_date', { ascending: true }).limit(100);
    res.json({ ok: true, events: data || [] });
  } catch (err) { res.status(500).json({ error: '조회 오류' }); }
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
