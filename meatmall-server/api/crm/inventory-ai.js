const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

const EXPIRY_WARNING_DAYS = 3;   // 유통기한 임박 기준 (일)
const OVERSTOCK_THRESHOLD = 100; // 과다재고 기준 수량

// ════════════════════════════════════════════════════
// GET /api/crm/inventory-ai — 재고 알림 목록
// ════════════════════════════════════════════════════
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { alert_type, status, page = 1, limit = 50 } = req.query;
    const from = (page - 1) * limit;
    const to   = from + Number(limit) - 1;

    let q = supabase
      .from('inventory_alerts')
      .select('*, products(name, price)', { count: 'exact' })
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
// ════════════════════════════════════════════════════
router.post('/run', requireAdmin, async (req, res) => {
  try {
    const today = new Date();
    const expiryLimit = new Date(today);
    expiryLimit.setDate(expiryLimit.getDate() + EXPIRY_WARNING_DAYS);

    // 상품 전체 조회 (stock_quantity, expiry_date 컬럼 존재 가정)
    const { data: products, error: prodErr } = await supabase
      .from('products')
      .select('id, name, stock_quantity, expiry_date')
      .eq('is_active', true);

    if (prodErr) throw prodErr;

    const alerts = [];

    for (const p of products || []) {
      const stock = Number(p.stock_quantity || 0);

      // 유통기한 임박
      if (p.expiry_date) {
        const expiry = new Date(p.expiry_date);
        const daysLeft = (expiry - today) / 86400000;
        if (daysLeft >= 0 && daysLeft <= EXPIRY_WARNING_DAYS) {
          const discountRate = daysLeft <= 1 ? 30 : daysLeft <= 2 ? 20 : 10;
          alerts.push({
            product_id:                p.id,
            alert_type:                '유통기한임박',
            current_stock:             stock,
            expiry_date:               p.expiry_date,
            recommended_discount_rate: discountRate,
            status:                    '대기',
          });
        }
      }

      // 과다재고
      if (stock > OVERSTOCK_THRESHOLD) {
        const discountRate = Math.min(30, Math.floor((stock - OVERSTOCK_THRESHOLD) / 10));
        alerts.push({
          product_id:                p.id,
          alert_type:                '과다재고',
          current_stock:             stock,
          expiry_date:               null,
          recommended_discount_rate: discountRate,
          status:                    '대기',
        });
      }
    }

    if (alerts.length === 0) {
      return res.json({ ok: true, detected: 0, message: '탐지된 이상 재고 없음' });
    }

    const { data: inserted, error: insErr } = await supabase
      .from('inventory_alerts')
      .insert(alerts)
      .select();

    if (insErr) throw insErr;

    res.json({ ok: true, detected: inserted.length, data: inserted });
  } catch (err) {
    console.error('[crm/inventory-ai/run]', err);
    res.status(500).json({ error: '재고 AI 탐지 오류' });
  }
});

// ════════════════════════════════════════════════════
// PUT /api/crm/inventory-ai/:id — 알림 상태 변경
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
