const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

// ════════════════════════════════════════════════════
// GET /api/crm/segments — 고객 등급 목록 조회
// ════════════════════════════════════════════════════
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { grade, page = 1, limit = 50 } = req.query;
    const from = (page - 1) * limit;
    const to   = from + Number(limit) - 1;

    let q = supabase
      .from('customer_segments')
      .select('*, users(name, email, phone)', { count: 'exact' })
      .order('total_spent', { ascending: false })
      .range(from, to);

    if (grade) q = q.eq('grade', grade);

    const { data, error, count } = await q;
    if (error) throw error;

    res.json({ ok: true, total: count, page: Number(page), data });
  } catch (err) {
    console.error('[crm/segments GET]', err);
    res.status(500).json({ error: '고객 등급 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/crm/segments/recalculate — 등급 전체 재계산
// ════════════════════════════════════════════════════
router.post('/recalculate', requireAdmin, async (req, res) => {
  try {
    // 주문 기반 집계: 완료 상태 주문만 합산
    const { data: stats, error: statErr } = await supabase
      .from('orders')
      .select('user_id, total_amount, created_at')
      .in('status', ['완료', '배송완료', 'completed', 'delivered']);

    if (statErr) throw statErr;

    // 유저별 집계
    const map = {};
    for (const row of stats) {
      if (!map[row.user_id]) {
        map[row.user_id] = { total_spent: 0, order_count: 0, last_order_at: null };
      }
      map[row.user_id].total_spent  += Number(row.total_amount || 0);
      map[row.user_id].order_count  += 1;
      const t = row.created_at;
      if (!map[row.user_id].last_order_at || t > map[row.user_id].last_order_at) {
        map[row.user_id].last_order_at = t;
      }
    }

    const now = new Date();
    const CHURN_DAYS = 90;
    const upserts = Object.entries(map).map(([user_id, s]) => {
      const daysSinceLast = s.last_order_at
        ? (now - new Date(s.last_order_at)) / 86400000
        : 9999;

      let grade = '일반';
      if (daysSinceLast >= CHURN_DAYS)       grade = '휴면';
      else if (s.total_spent >= 1000000)     grade = 'VIP';
      else if (s.total_spent >= 500000)      grade = 'GOLD';
      else if (s.total_spent >= 200000)      grade = 'SILVER';

      const churn_risk_score = Math.min(1, daysSinceLast / (CHURN_DAYS * 2));

      return {
        user_id,
        grade,
        total_spent:      s.total_spent,
        order_count:      s.order_count,
        last_order_at:    s.last_order_at,
        churn_risk_score: Number(churn_risk_score.toFixed(3)),
        calculated_at:    now.toISOString(),
      };
    });

    if (upserts.length === 0) {
      return res.json({ ok: true, updated: 0, message: '집계할 주문이 없습니다' });
    }

    const { error: upsertErr } = await supabase
      .from('customer_segments')
      .upsert(upserts, { onConflict: 'user_id' });

    if (upsertErr) throw upsertErr;

    res.json({ ok: true, updated: upserts.length });
  } catch (err) {
    console.error('[crm/segments/recalculate]', err);
    res.status(500).json({ error: '등급 재계산 오류' });
  }
});

module.exports = router;
