const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

router.use(requireAdmin);

// GET /api/admin/vendor-inventory/alert — /:vendorId 보다 먼저 등록
router.get('/alert', async (req, res) => {
  try {
    const { data: inv, error } = await supabase
      .from('vendor_inventory')
      .select('*, vendors(vendor_name), products(name, thumbnail_url)');
    if (error) throw error;

    const alerts = (inv || [])
      .filter(i => Number(i.current_stock) <= Number(i.safety_stock))
      .map(i => ({
        ...i,
        shortage: Math.max(0, Number(i.safety_stock) - Number(i.current_stock))
      }))
      .sort((a, b) => b.shortage - a.shortage);

    res.json({ ok: true, alerts });
  } catch (err) {
    console.error('[vendor-inventory/alert GET]', err);
    res.status(500).json({ error: '재고 알림 조회 오류' });
  }
});

// GET /api/admin/vendor-inventory/:vendorId
router.get('/:vendorId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendor_inventory')
      .select('*, products(name, thumbnail_url)')
      .eq('vendor_id', req.params.vendorId);
    if (error) throw error;

    const result = (data || []).map(i => ({
      ...i,
      is_low: Number(i.current_stock) <= Number(i.safety_stock),
      shortage: Math.max(0, Number(i.safety_stock) - Number(i.current_stock))
    }));

    res.json({ ok: true, inventory: result });
  } catch (err) {
    console.error('[vendor-inventory GET/:vendorId]', err);
    res.status(500).json({ error: '재고 조회 오류' });
  }
});

// PUT /api/admin/vendor-inventory
router.put('/', async (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: '재고 항목 배열이 필요합니다' });
    }

    const upserted = [];
    for (const item of items) {
      const { vendor_id, product_id, current_stock, safety_stock } = item;
      const update = { vendor_id, product_id, last_updated: new Date().toISOString() };
      if (current_stock !== undefined) update.current_stock = Number(current_stock);
      if (safety_stock !== undefined) update.safety_stock = Number(safety_stock);

      const { data, error } = await supabase
        .from('vendor_inventory')
        .upsert(update, { onConflict: 'vendor_id,product_id' })
        .select()
        .single();
      if (error) throw error;
      upserted.push(data);
    }

    res.json({ ok: true, updated: upserted.length, inventory: upserted });
  } catch (err) {
    console.error('[vendor-inventory PUT]', err);
    res.status(500).json({ error: '재고 업데이트 오류' });
  }
});

module.exports = router;
