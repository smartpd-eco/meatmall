const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');
const { calculateCustomerGrade } = require('../../lib/crm-engine');

// ════════════════════════════════════════════════════
// GET /api/crm/segments
//   ?grade=VIP|GOLD|SILVER|일반|휴면
//   ?churn_risk_min=0.0~1.0
//   ?page=1&limit=50
// ════════════════════════════════════════════════════
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { grade, churn_risk_min, page = 1, limit = 50 } = req.query;
    const from = (Number(page) - 1) * Number(limit);
    const to   = from + Number(limit) - 1;

    let q = supabase
      .from('customer_segments')
      .select('*, users(name, email)', { count: 'exact' })
      .order('total_spent', { ascending: false })
      .range(from, to);

    if (grade)           q = q.eq('grade', grade);
    if (churn_risk_min)  q = q.gte('churn_risk_score', Number(churn_risk_min));

    const { data, error, count } = await q;
    if (error) throw error;

    res.json({ ok: true, total: count, page: Number(page), data });
  } catch (err) {
    console.error('[crm/segments GET]', err);
    res.status(500).json({ error: '고객 등급 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/crm/segments/recalculate
//   전체 활성 유저(is_active=true)를 대상으로 등급 일괄 재계산
//   반환: { total, VIP, GOLD, SILVER, 일반, 휴면, errors }
// ════════════════════════════════════════════════════
router.post('/recalculate', requireAdmin, async (req, res) => {
  try {
    // 활성 유저 전체 조회
    const { data: users, error: usrErr } = await supabase
      .from('users')
      .select('id')
      .eq('is_active', true);

    if (usrErr) throw usrErr;
    if (!users || users.length === 0) {
      return res.json({ ok: true, total: 0, VIP: 0, GOLD: 0, SILVER: 0, 일반: 0, 휴면: 0, errors: 0 });
    }

    const counts = { VIP: 0, GOLD: 0, SILVER: 0, 일반: 0, 휴면: 0 };
    let errors = 0;

    // 순차 처리 (Vercel 서버리스 메모리 보호 — 배치 병렬보다 안전)
    for (const user of users) {
      try {
        const result = await calculateCustomerGrade(user.id);
        counts[result.grade] = (counts[result.grade] || 0) + 1;
      } catch (err) {
        console.error(`[recalculate] userId=${user.id}`, err.message);
        errors++;
      }
    }

    res.json({
      ok:    true,
      total: users.length,
      ...counts,
      errors,
    });
  } catch (err) {
    console.error('[crm/segments/recalculate]', err);
    res.status(500).json({ error: '등급 재계산 오류' });
  }
});

module.exports = router;
