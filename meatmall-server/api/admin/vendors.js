const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');
const { kakaoGeocode } = require('../../lib/geocode');

router.use(requireAdmin);

// POST /api/admin/vendors/geocode-all — 전 거래처 주소 → 좌표 일괄 생성
//  body: { force?: boolean }  force=true면 좌표 있어도 재생성
//  (KAKAO_REST_API_KEY 필요. 없으면 전부 실패로 표시)
router.post('/geocode-all', async (req, res) => {
  try {
    const force = req.body && req.body.force === true;
    const { data: vendors } = await supabase.from('vendors').select('id, address, lat, lng');
    let updated = 0, skipped = 0, failed = 0;
    for (const v of (vendors || [])) {
      if (!v.address) { skipped++; continue; }
      if (!force && v.lat != null && v.lng != null) { skipped++; continue; }
      const g = await kakaoGeocode(v.address);
      if (!g) { failed++; continue; }
      await supabase.from('vendors').update({ lat: g.lat, lng: g.lng, updated_at: new Date().toISOString() }).eq('id', v.id);
      updated++;
    }
    res.json({ ok: true, updated, skipped, failed, total: (vendors || []).length });
  } catch (err) {
    console.error('[vendors geocode-all]', err);
    res.status(500).json({ error: '좌표 일괄 생성 오류' });
  }
});

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
    const { vendor_name, owner_name, phone, address, city, district, dong, business_hours,
      same_day_enabled, same_day_radius_km, same_day_cutoff, daily_order_limit } = req.body;
    if (!vendor_name) return res.status(400).json({ error: '거래처명은 필수입니다' });

    // 주소 → 좌표 (키 있을 때만; 없으면 null)
    let { lat, lng } = req.body;
    if ((lat == null || lng == null) && address) {
      const geo = await kakaoGeocode(address);
      if (geo) { lat = geo.lat; lng = geo.lng; }
    }

    const row = { vendor_name, owner_name, phone, address, city, district, dong, lat, lng, business_hours };
    if (same_day_enabled   !== undefined) row.same_day_enabled   = !!same_day_enabled;
    if (same_day_radius_km !== undefined) row.same_day_radius_km = Number(same_day_radius_km);
    if (same_day_cutoff    !== undefined) row.same_day_cutoff    = same_day_cutoff;
    if (daily_order_limit  !== undefined) row.daily_order_limit  = Number(daily_order_limit);

    const { data, error } = await supabase
      .from('vendors')
      .insert(row)
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
    const allowed = ['vendor_name', 'owner_name', 'phone', 'address', 'city', 'district', 'dong', 'lat', 'lng', 'business_hours', 'is_active',
      'same_day_enabled', 'same_day_radius_km', 'same_day_cutoff', 'daily_order_limit'];
    const update = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    // 주소가 바뀌었는데 좌표를 직접 주지 않았으면 재지오코딩
    if (update.address !== undefined && req.body.lat === undefined && req.body.lng === undefined) {
      const geo = await kakaoGeocode(update.address);
      if (geo) { update.lat = geo.lat; update.lng = geo.lng; }
    }

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

// ── 벤더 계정 연결 ─────────────────────────────────────
// GET /api/admin/vendors/:id/accounts — 이 거래처에 연결된 회원 목록
router.get('/:id/accounts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, phone, role, is_active')
      .eq('vendor_id', req.params.id);
    if (error) throw error;
    res.json({ ok: true, accounts: data || [] });
  } catch (err) {
    console.error('[vendors GET/:id/accounts]', err);
    res.status(500).json({ error: '연결 계정 조회 오류' });
  }
});

// POST /api/admin/vendors/:id/link-account — 이메일 회원에 벤더 권한 부여
router.post('/:id/link-account', async (req, res) => {
  try {
    const email = (req.body.email || '').trim();
    if (!email) return res.status(400).json({ error: '이메일을 입력해주세요' });

    const { data: user } = await supabase
      .from('users').select('id, email, name').eq('email', email).single();
    if (!user) return res.status(404).json({ error: '해당 이메일의 회원이 없습니다. 먼저 회원가입이 필요합니다.' });

    const { data, error } = await supabase
      .from('users')
      .update({ vendor_id: Number(req.params.id), role: 'vendor', updated_at: new Date().toISOString() })
      .eq('id', user.id)
      .select('id, name, email, role, vendor_id')
      .single();
    if (error) throw error;
    res.json({ ok: true, user: data });
  } catch (err) {
    console.error('[vendors POST/:id/link-account]', err);
    res.status(500).json({ error: '계정 연결 오류' });
  }
});

// POST /api/admin/vendors/:id/unlink-account — 벤더 권한 해제
router.post('/:id/unlink-account', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id가 필요합니다' });

    const { data, error } = await supabase
      .from('users')
      .update({ vendor_id: null, role: 'customer', updated_at: new Date().toISOString() })
      .eq('id', user_id)
      .eq('vendor_id', req.params.id)
      .select('id, name, email')
      .single();
    if (error) throw error;
    res.json({ ok: true, user: data });
  } catch (err) {
    console.error('[vendors POST/:id/unlink-account]', err);
    res.status(500).json({ error: '연결 해제 오류' });
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
