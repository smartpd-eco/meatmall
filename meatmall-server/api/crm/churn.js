const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

// ════════════════════════════════════════════════════
// GET /api/crm/churn — 휴면/이탈위험 고객 탐지
// ════════════════════════════════════════════════════
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { risk = 'all', page = 1, limit = 50 } = req.query;
    const from = (page - 1) * limit;
    const to   = from + Number(limit) - 1;

    // 휴면 고객 (grade = '휴면')
    // 이탈위험 고객 (churn_risk_score >= 0.6)
    let q = supabase
      .from('customer_segments')
      .select('*, users(name, email, phone)', { count: 'exact' })
      .order('churn_risk_score', { ascending: false })
      .range(from, to);

    if (risk === 'churn') {
      q = q.eq('grade', '휴면');
    } else if (risk === 'risk') {
      q = q.gte('churn_risk_score', 0.6).neq('grade', '휴면');
    } else {
      // 전체: 휴면 + 이탈위험
      q = q.or('grade.eq.휴면,churn_risk_score.gte.0.6');
    }

    const { data, error, count } = await q;
    if (error) throw error;

    const summary = {
      total_churn: data?.filter(d => d.grade === '휴면').length || 0,
      high_risk:   data?.filter(d => d.churn_risk_score >= 0.6 && d.grade !== '휴면').length || 0,
    };

    res.json({ ok: true, total: count, page: Number(page), summary, data });
  } catch (err) {
    console.error('[crm/churn GET]', err);
    res.status(500).json({ error: '휴면고객 조회 오류' });
  }
});

module.exports = router;
