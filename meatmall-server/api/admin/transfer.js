// ════════════════════════════════════════════════════
//  특허1 확장: 본사 임박재고 → 매장 이전 (추천 → 승인 → 실행)
//  추천: 임박 로트(본사) × 거리 근사(HQ_LAT/HQ_LNG) × 필요매장(재고부족+수요)
//  승인: 본사 로트/재고 차감 + 매장(vendor_inventory) 증가 + 기록
//  전부 신규 라우트(관리자 전용) — 기존 무영향, 승인 전까진 아무것도 안 바뀜.
// ════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');
const { haversineKm } = require('../../lib/geocode');
const { productWasteRisk } = require('../../lib/lot-risk');

router.use(requireAdmin);

function hqCoord() {
  const lat = Number(process.env.HQ_LAT), lng = Number(process.env.HQ_LNG);
  return (lat && lng) ? { lat, lng } : null;
}

// GET /api/admin/transfer/recommendations?days=3&max_km=30
router.get('/recommendations', async (req, res) => {
  try {
    const days = Number(req.query.days) || 3;            // 임박 기준(일)
    const maxKm = Number(req.query.max_km) || Number(process.env.TRANSFER_MAX_KM) || 30;
    const hq = hqCoord();
    const until = new Date(Date.now() + days * 86400000).toISOString();

    // 1) 본사 임박 로트 (active·유통기한 임박·잔여>0), 본사 상품(vendor_id null)만
    const { data: lots } = await supabase.from('product_lots')
      .select('id, product_id, qty_remaining, expiry_at, products(name, category, vendor_id)')
      .eq('status', 'active').gt('qty_remaining', 0)
      .not('expiry_at', 'is', null).lte('expiry_at', until)
      .order('expiry_at', { ascending: true }).limit(50);
    const hqLots = (lots || []).filter(l => l.products && l.products.vendor_id == null);

    // 최근 7일 수요(vendor_orders) 준비 — 매장별 발주 건수(수요 가점)
    const recs = [];
    for (const lot of hqLots) {
      const pid = lot.product_id;
      // 2) 필요매장: 해당 상품 재고부족(vendor_inventory)
      const { data: inv } = await supabase.from('vendor_inventory')
        .select('vendor_id, current_stock, safety_stock').eq('product_id', pid);
      const shortMap = {};
      (inv || []).forEach(iv => {
        const shortage = Number(iv.safety_stock || 0) - Number(iv.current_stock || 0);
        if (shortage > 0) shortMap[iv.vendor_id] = shortage;
      });
      const vids = Object.keys(shortMap).map(Number);
      if (!vids.length) continue;

      // 매장 좌표·상태
      const { data: vs } = await supabase.from('vendors')
        .select('id, vendor_name, lat, lng, is_active, dong').in('id', vids);
      const cands = [];
      for (const v of (vs || [])) {
        if (!v.is_active) continue;
        let km = null;
        if (hq && v.lat != null && v.lng != null) {
          km = haversineKm(hq.lat, hq.lng, v.lat, v.lng);
          if (km > maxKm) continue;           // 이동경로(거리) 밖 제외
        }
        cands.push({ vendor_id: v.id, vendor_name: v.vendor_name, dong: v.dong, shortage: shortMap[v.id], km });
      }
      if (!cands.length) continue;
      cands.sort((a, b) => b.shortage - a.shortage || ((a.km ?? 1e9) - (b.km ?? 1e9)));
      const top = cands[0];
      recs.push({
        lot_id: lot.id, product_id: pid, product_name: lot.products.name, category: lot.products.category,
        expiry_at: lot.expiry_at, qty_remaining: Number(lot.qty_remaining),
        waste_risk: productWasteRisk({}, [{ expiry_at: lot.expiry_at, qty_remaining: lot.qty_remaining }]),
        to_vendor_id: top.vendor_id, to_vendor_name: top.vendor_name, to_dong: top.dong,
        shortage: top.shortage, distance_km: top.km != null ? Math.round(top.km * 10) / 10 : null,
        suggest_qty: Math.min(Number(lot.qty_remaining), top.shortage),
        alternatives: cands.slice(1, 4).map(c => ({ ...c, km: c.km != null ? Math.round(c.km * 10) / 10 : null }))
      });
    }
    res.json({ ok: true, hq_set: !!hq, max_km: maxKm, days, recommendations: recs });
  } catch (err) { console.error('[transfer/recommendations]', err); res.status(500).json({ error: err.message || '추천 조회 오류' }); }
});

// POST /api/admin/transfer/approve  — 이전 실행(승인)
router.post('/approve', async (req, res) => {
  try {
    const { lot_id, product_id, to_vendor_id, qty, distance_km, reason } = req.body || {};
    if (!product_id || !to_vendor_id || !qty) return res.status(400).json({ error: 'product_id·to_vendor_id·qty는 필수입니다' });
    const q = Number(qty);

    // 본사 로트 차감
    if (lot_id) {
      const { data: lot } = await supabase.from('product_lots').select('qty_remaining').eq('id', lot_id).single();
      if (lot) {
        const rem = Math.max(0, Number(lot.qty_remaining) - q);
        await supabase.from('product_lots').update({ qty_remaining: rem, status: rem <= 0 ? 'soldout' : 'active', updated_at: new Date().toISOString() }).eq('id', lot_id);
      }
    }
    // 본사 상품 재고 차감
    const { data: prod } = await supabase.from('products').select('stock').eq('id', product_id).single();
    if (prod) await supabase.from('products').update({ stock: Math.max(0, Number(prod.stock || 0) - q) }).eq('id', product_id);

    // 매장 재고 증가(있으면 update, 없으면 insert)
    const { data: iv } = await supabase.from('vendor_inventory').select('id, current_stock').eq('vendor_id', to_vendor_id).eq('product_id', product_id).maybeSingle();
    if (iv) await supabase.from('vendor_inventory').update({ current_stock: Number(iv.current_stock || 0) + q }).eq('id', iv.id);
    else await supabase.from('vendor_inventory').insert({ vendor_id: to_vendor_id, product_id, current_stock: q, safety_stock: 0 });

    // 기록
    const { data: tr } = await supabase.from('stock_transfers').insert({
      lot_id: lot_id || null, product_id, to_vendor_id, qty: q,
      distance_km: distance_km || null, reason: reason || '유통기한 임박 이전', status: 'done', approved_at: new Date().toISOString()
    }).select().single();
    res.json({ ok: true, transfer: tr });
  } catch (err) { console.error('[transfer/approve]', err); res.status(500).json({ error: err.message || '이전 처리 오류' }); }
});

module.exports = router;
