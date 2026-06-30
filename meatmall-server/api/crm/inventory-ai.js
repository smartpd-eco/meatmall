const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');
const { detectInventoryAlerts } = require('../../lib/crm-engine');

// ════════════════════════════════════════════════════
// GET /api/crm/inventory-ai
//   ?alert_type=유통기한임박|과다재고
//   ?status=대기|적용됨|무시됨
//   ?page=1&limit=50
// ════════════════════════════════════════════════════
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { alert_type, status, page = 1, limit = 50 } = req.query;
    const from = (Number(page) - 1) * Number(limit);
    const to   = from + Number(limit) - 1;

    let q = supabase
      .from('inventory_alerts')
      .select('*, products(name, stock, expiry_days, price)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (alert_type) q = q.eq('alert_type', alert_type);
    if (status)     q = q.eq('status', status);

    const { data, error, count } = await q;
    if (error) throw error;

    res.json({ ok: true, total: count, page: Number(page), data });
  } catch (err) {
    console.error('[crm/inventory-ai GET]', err);
    res.status(500).json({ error: '재고 알림 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/crm/inventory-ai/run — AI 탐지 실행
//   반환: { detected, expiry, overstock }
// ════════════════════════════════════════════════════
router.post('/run', requireAdmin, async (req, res) => {
  try {
    const result = await detectInventoryAlerts();

    if (result.detected === 0) {
      return res.json({ ok: true, detected: 0, expiry: 0, overstock: 0, message: '탐지된 이상 재고 없음' });
    }

    res.json({
      ok:       true,
      detected: result.detected,
      expiry:   result.expiry,
      overstock: result.overstock,
    });
  } catch (err) {
    console.error('[crm/inventory-ai/run]', err);
    res.status(500).json({ error: '재고 AI 탐지 오류' });
  }
});

// ════════════════════════════════════════════════════
// PUT /api/crm/inventory-ai/:id — 알림 상태 변경
//   body: { status: '적용됨' | '무시됨' | '대기' }
// ════════════════════════════════════════════════════
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['대기', '적용됨', '무시됨'].includes(status)) {
      return res.status(400).json({ error: 'status 는 대기/적용됨/무시됨 만 허용됩니다' });
    }

    const { data, error } = await supabase
      .from('inventory_alerts')
      .update({ status })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: '알림을 찾을 수 없습니다' });

    res.json({ ok: true, data });
  } catch (err) {
    console.error('[crm/inventory-ai PUT]', err);
    res.status(500).json({ error: '알림 상태 변경 오류' });
  }
});

module.exports = router;
