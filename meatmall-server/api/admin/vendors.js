const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

router.use(requireAdmin);

// GET /api/admin/vendors
router.get('/', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const { data: vendors, error } = await supabase
      .from('vendors')
      .select('*')
      .order('is_active', { ascending: false })
      .order('score', { ascending: false });
    if (error) throw error;

    const result = await Promise.all(
      vendors.map(async v => {
        const { count } = await supabase
          .from('order_assignments')
          .select('id', { count: 'exact', head: true })
          .eq('vendor_id', v.id)
          .gte('assigned_at', today);
        return { ...v, today_orders: count || 0 };
      })
    );

    res.json({ ok: true, vendors: result });
  } catch (err) {
    console.error('[vendors GET]', err);
    res.status(500).json({ error: '거래처 조회 오류' });
  }
});

// GET /api/admin/vendors/:id
router.get('/:id', async (req, res) => {
  try {
    const { data: vendor, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !vendor) return res.status(404).json({ error: '거래처를 찾을 수 없습니다' });

    const { data: inventory } = await supabase
      .from('vendor_inventory')
      .select('*, products(name, thumbnail_url)')
      .eq('vendor_id', req.params.id);

    const { data: recentAssignments } = await supabase
      .from('order_assignments')
      .select('*, orders(order_number, total_amount, status)')
      .eq('vendor_id', req.params.id)
      .order('assigned_at', { ascending: false })
      .limit(5);

    res.json({
      ok: true,
      vendor,
      inventory: inventory || [],
      recent_assignments: recentAssignments || []
    });
  } catch (err) {
    console.error('[vendors GET/:id]', err);
    res.status(500).json({ error: '거래처 상세 조회 오류' });
  }
});

// POST /api/admin/vendors
router.post('/', async (req, res) => {
  try {
    const { vendor_name, owner_name, phone, address, city, district, dong, lat, lng, business_hours } = req.body;
    if (!vendor_name) return res.status(400).json({ error: '거래처명은 필수입니다' });

    const { data, error } = await supabase
      .from('vendors')
      .insert({ vendor_name, owner_name, phone, address, city, district, dong, lat, lng, business_hours })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ ok: true, vendor: data });
  } catch (err) {
    console.error('[vendors POST]', err);
    res.status(500).json({ error: '거래처 등록 오류' });
  }
});

// PUT /api/admin/vendors/:id
router.put('/:id', async (req, res) => {
  try {
    const allowed = ['vendor_name', 'owner_name', 'phone', 'address', 'city', 'district', 'dong', 'lat', 'lng', 'business_hours', 'is_active'];
    const update = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    const { data, error } = await supabase
      .from('vendors')
      .update(update)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;

    res.json({ ok: true, vendor: data });
  } catch (err) {
    console.error('[vendors PUT/:id]', err);
    res.status(500).json({ error: '거래처 수정 오류' });
  }
});

// DELETE /api/admin/vendors/:id — 비활성화 (실제 삭제 아님)
router.delete('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendors')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, vendor: data });
  } catch (err) {
    console.error('[vendors DELETE/:id]', err);
    res.status(500).json({ error: '거래처 비활성화 오류' });
  }
});

// POST /api/admin/vendors/:id/zones
router.post('/:id/zones', async (req, res) => {
  try {
    const { zone_id, priority = 1, is_primary = false, max_daily_orders = 50, avail_time_min = 60 } = req.body;
    if (!zone_id) return res.status(400).json({ error: 'zone_id는 필수입니다' });

    const { data, error } = await supabase
      .from('vendor_zones')
      .upsert(
        { vendor_id: Number(req.params.id), zone_id, priority, is_primary, max_daily_orders, avail_time_min },
        { onConflict: 'vendor_id,zone_id' }
      )
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ ok: true, vendor_zone: data });
  } catch (err) {
    console.error('[vendors POST/:id/zones]', err);
    res.status(500).json({ error: '권역 매핑 오류' });
  }
});

// GET /api/admin/vendors/:id/scores
router.get('/:id/scores', async (req, res) => {
  try {
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from('vendor_scores')
      .select('*')
      .eq('vendor_id', req.params.id)
      .gte('score_date', from)
      .order('score_date', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, scores: data || [] });
  } catch (err) {
    console.error('[vendors GET/:id/scores]', err);
    res.status(500).json({ error: '점수 이력 조회 오류' });
  }
});

module.exports = router;
