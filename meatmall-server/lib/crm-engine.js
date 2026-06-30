const supabase = require('./supabase');

const CHURN_DAYS   = 90;
const GRADE_VIP    = 1_000_000;
const GRADE_GOLD   =   500_000;
const GRADE_SILVER =   100_000;

// ════════════════════════════════════════════════════
// calculateCustomerGrade(userId)
//   1. orders(status='delivered') 조회
//   2. 최근 90일 주문 없으면 → '휴면'
//   3. total_spent 기준 등급 결정
//   4. churn_risk_score = 경과일 / 평균구매주기 (0~1 클램프)
//   5. customer_segments upsert
// ════════════════════════════════════════════════════
async function calculateCustomerGrade(userId) {
  // 해당 유저의 완료 주문 전체 조회 (오름차순 — 주기 계산용)
  const { data: orders, error } = await supabase
    .from('orders')
    .select('total_amount, created_at')
    .eq('user_id', userId)
    .eq('status', 'delivered')
    .order('created_at', { ascending: true });

  if (error) throw error;

  const now          = new Date();
  const nowMs        = now.getTime();
  const CHURN_MS     = CHURN_DAYS * 86400000;

  // 주문 없는 경우: 초기 일반 등록
  if (!orders || orders.length === 0) {
    const segment = {
      user_id:           userId,
      grade:             '일반',
      total_spent:       0,
      order_count:       0,
      last_order_at:     null,
      churn_risk_score:  0,
      calculated_at:     now.toISOString(),
    };
    await supabase
      .from('customer_segments')
      .upsert(segment, { onConflict: 'user_id' });
    return segment;
  }

  // 총 결제액 / 주문 수
  const total_spent = orders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
  const order_count = orders.length;

  // 마지막 주문일
  const lastOrderAt     = new Date(orders[order_count - 1].created_at);
  const daysSinceLast   = (nowMs - lastOrderAt.getTime()) / 86400000;

  // 등급 결정 (휴면 최우선)
  let grade;
  if (daysSinceLast >= CHURN_DAYS) {
    grade = '휴면';
  } else if (total_spent >= GRADE_VIP) {
    grade = 'VIP';
  } else if (total_spent >= GRADE_GOLD) {
    grade = 'GOLD';
  } else if (total_spent >= GRADE_SILVER) {
    grade = 'SILVER';
  } else {
    grade = '일반';
  }

  // 평균 구매주기 계산 (주문이 2개 이상일 때만 유의미)
  let avgCycleDays = CHURN_DAYS; // 기본값: 휴면 기준으로 정규화
  if (order_count >= 2) {
    const firstOrderAt = new Date(orders[0].created_at);
    const spanDays     = (lastOrderAt.getTime() - firstOrderAt.getTime()) / 86400000;
    avgCycleDays       = spanDays / (order_count - 1);
  }

  // churn_risk_score: 0(방금 구매) ~ 1(평균주기 이상 경과)
  // avgCycleDays가 0에 가까운 경우(같은날 주문) 예외처리
  const churn_risk_score = avgCycleDays > 0
    ? Math.min(1, Number((daysSinceLast / avgCycleDays).toFixed(3)))
    : Math.min(1, Number((daysSinceLast / CHURN_DAYS).toFixed(3)));

  const segment = {
    user_id:          userId,
    grade,
    total_spent,
    order_count,
    last_order_at:    lastOrderAt.toISOString(),
    churn_risk_score,
    calculated_at:    now.toISOString(),
  };

  const { error: upsertErr } = await supabase
    .from('customer_segments')
    .upsert(segment, { onConflict: 'user_id' });

  if (upsertErr) throw upsertErr;

  return segment;
}

module.exports = { calculateCustomerGrade };
