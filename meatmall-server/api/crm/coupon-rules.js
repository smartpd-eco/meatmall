const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

// ════════════════════════════════════════════════════
// GET /api/crm/coupon-rules — 쿠폰 규칙 목록
// ════════════════════════════════════════════════════
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { is_active, trigger_type } = req.query;

    let q = supabase
      .from('auto_coupon_rules')
      .select('*')
      .order('created_at', { ascending: false });

    if (is_active     !== undefined) q = q.eq('is_active', is_active === 'true');
    if (trigger_type)                q = q.eq('trigger_type', trigger_type);

    const { data, error } = await q;
    if (error) throw error;

    res.json({ ok: true, data });
  } catch (err) {
    console.error('[crm/coupon-rules GET]', err);
    res.status(500).json({ error: '쿠폰 규칙 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/crm/coupon-rules — 쿠폰 규칙 생성
// ════════════════════════════════════════════════════
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { rule_name, trigger_type, coupon_value, coupon_type, condition } = req.body;

    if (!rule_name || !trigger_type || coupon_value === undefined || !coupon_type) {
      return res.status(400).json({ error: 'rule_name, trigger_type, coupon_value, coupon_type 는 필수입니다' });
    }
    if (!['회원가입', '재방문', '휴면복귀', 'VIP'].includes(trigger_type)) {
      return res.status(400).json({ error: 'trigger_type 은 회원가입/재방문/휴면복귀/VIP 만 허용됩니다' });
    }
    if (!['정액', '정률'].includes(coupon_type)) {
      return res.status(400).json({ error: 'coupon_type 은 정액 또는 정률 이어야 합니다' });
    }

    const { data, error } = await supabase
      .from('auto_coupon_rules')
      .insert({ rule_name, trigger_type, coupon_value, coupon_type, condition: condition || null, is_active: true })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, data });
  } catch (err) {
    console.error('[crm/coupon-rules POST]', err);
    res.status(500).json({ error: '쿠폰 규칙 생성 오류' });
  }
});

// ════════════════════════════════════════════════════
// PUT /api/crm/coupon-rules/:id — 쿠폰 규칙 수정
// ════════════════════════════════════════════════════
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { rule_name, coupon_value, coupon_type, condition, is_active } = req.body;

    const updates = {};
    if (rule_name    !== undefined) updates.rule_name    = rule_name;
    if (coupon_value !== undefined) updates.coupon_value = coupon_value;
    if (coupon_type  !== undefined) {
      if (!['정액', '정률'].includes(coupon_type)) {
        return res.status(400).json({ error: 'coupon_type 은 정액 또는 정률 이어야 합니다' });
      }
      updates.coupon_type = coupon_type;
    }
    if (condition  !== undefined) updates.condition  = condition;
    if (is_active  !== undefined) updates.is_active  = Boolean(is_active);

    const { data, error } = await supabase
      .from('auto_coupon_rules')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: '쿠폰 규칙을 찾을 수 없습니다' });

    res.json({ ok: true, data });
  } catch (err) {
    console.error('[crm/coupon-rules PUT]', err);
    res.status(500).json({ error: '쿠폰 규칙 수정 오류' });
  }
});

// ════════════════════════════════════════════════════
// DELETE /api/crm/coupon-rules/:id — 쿠폰 규칙 삭제
// ════════════════════════════════════════════════════
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('auto_coupon_rules')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[crm/coupon-rules DELETE]', err);
    res.status(500).json({ error: '쿠폰 규칙 삭제 오류' });
  }
});

module.exports = router;
