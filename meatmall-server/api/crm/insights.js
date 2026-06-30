const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

// ════════════════════════════════════════════════════
// GET /api/crm/insights/:userId — 특정 회원 구매패턴 조회/갱신
// ════════════════════════════════════════════════════
router.get('/:userId', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    // 기존 insights 먼저 조회
    const { data: existing } = await supabase
      .from('customer_insights')
      .select('*, categories(name)')
      .eq('user_id', userId)
      .order('analyzed_at', { ascending: false })
      .limit(1)
      .single();

    // 주문 데이터로 실시간 분석
    const { data: orders, error: ordErr } = await supabase
      .from('orders')
      .select('total_amount, created_at, items')
      .eq('user_id', userId)
      .in('status', ['완료', '배송완료', 'completed', 'delivered'])
      .order('created_at', { ascending: true });

    if (ordErr) throw ordErr;

    if (!orders || orders.length === 0) {
      return res.json({ ok: true, data: existing || null, message: '주문 이력 없음' });
    }

    // 평균 주문금액
    const total = orders.reduce((s, o) => s + Number(o.total_amount || 0), 0);
    const avg_order_value = Math.round(total / orders.length);

    // 구매 주기 (일 단위)
    let purchase_cycle_days = null;
    if (orders.length >= 2) {
      const gaps = [];
      for (let i = 1; i < orders.length; i++) {
        const diff = (new Date(orders[i].created_at) - new Date(orders[i-1].created_at)) / 86400000;
        gaps.push(diff);
      }
      purchase_cycle_days = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
    }

    // 선호 시간대 (시간 기준)
    const hourCounts = {};
    for (const o of orders) {
      const h = new Date(o.created_at).getHours();
      const slot = h < 6 ? '새벽' : h < 12 ? '오전' : h < 18 ? '오후' : '저녁';
      hourCounts[slot] = (hourCounts[slot] || 0) + 1;
    }
    const preferred_time_slot = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // 선호 카테고리 — items 컬럼이 JSONB 배열이라고 가정
    let favorite_category_id = existing?.favorite_category_id || null;
    try {
      const catCount = {};
      for (const o of orders) {
        const items = Array.isArray(o.items) ? o.items : JSON.parse(o.items || '[]');
        for (const item of items) {
          if (item.category_id) {
            catCount[item.category_id] = (catCount[item.category_id] || 0) + 1;
          }
        }
      }
      const topCat = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0];
      if (topCat) favorite_category_id = Number(topCat[0]);
    } catch (_) {}

    const payload = {
      user_id:              userId,
      favorite_category_id,
      avg_order_value,
      purchase_cycle_days,
      preferred_time_slot,
      analyzed_at:          new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from('customer_insights')
      .upsert(payload, { onConflict: 'user_id' });

    if (upsertErr) throw upsertErr;

    res.json({ ok: true, data: payload });
  } catch (err) {
    console.error('[crm/insights GET]', err);
    res.status(500).json({ error: '구매패턴 분석 오류' });
  }
});

module.exports = router;
