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

// ════════════════════════════════════════════════════
// detectInventoryAlerts()
//   재고 소스:
//     - vendor_inventory.current_stock  (공급업체별 재고)
//     - products.stock                  (직접 재고 — vendor_inventory 없는 상품 보완)
//   유통기한:
//     - products.expiry_days(일수)은 날짜가 아님
//       → vendor_inventory.last_updated + expiry_days = 예상 만료일로 계산
//   할인율:
//     - 유통기한임박: 1일=50%, 2일=40%, 3일=30%
//     - 과다재고:     100~150개=10%, 150~200개=20%, 200개↑=30%
// ════════════════════════════════════════════════════
async function detectInventoryAlerts() {
  const OVERSTOCK_THRESHOLD = 100; // 과다재고 기준 수량
  const EXPIRY_WARNING_DAYS = 3;   // 유통기한 임박 경고 기준 (일)

  const todayMs = new Date().getTime();
  const alerts = [];
  const processedIds = new Set(); // product_id 중복 방지

  // ── 1단계: vendor_inventory + products 조인 ───────────────
  //   last_updated(입고일 프록시) + expiry_days = 예상 만료일
  const { data: vendorInv, error: viErr } = await supabase
    .from('vendor_inventory')
    .select('product_id, current_stock, last_updated, products(id, stock, expiry_days, name)');

  if (viErr) throw viErr;

  for (const vi of vendorInv || []) {
    const product      = vi.products;
    if (!product) continue;

    const currentStock = Number(vi.current_stock || 0);
    const expiryDays   = Number(product.expiry_days || 0);

    // 유통기한임박 탐지
    if (expiryDays > 0 && vi.last_updated && currentStock > 0) {
      const expiryDate = new Date(new Date(vi.last_updated).getTime() + expiryDays * 86400000);
      const daysLeft   = Math.ceil((expiryDate.getTime() - todayMs) / 86400000);

      if (daysLeft >= 0 && daysLeft <= EXPIRY_WARNING_DAYS) {
        const discountRate = daysLeft <= 1 ? 50 : daysLeft <= 2 ? 40 : 30;
        alerts.push({
          product_id:                vi.product_id,
          alert_type:                '유통기한임박',
          current_stock:             currentStock,
          expiry_date:               expiryDate.toISOString().split('T')[0],
          recommended_discount_rate: discountRate,
          status:                    '대기',
        });
        processedIds.add(vi.product_id);
      }
    }

    // 과다재고 탐지 (vendor_inventory.current_stock 기준)
    if (currentStock > OVERSTOCK_THRESHOLD) {
      const discountRate = currentStock >= 200 ? 30 : currentStock >= 150 ? 20 : 10;
      alerts.push({
        product_id:                vi.product_id,
        alert_type:                '과다재고',
        current_stock:             currentStock,
        expiry_date:               null,
        recommended_discount_rate: discountRate,
        status:                    '대기',
      });
      processedIds.add(vi.product_id);
    }
  }

  // ── 2단계: products.stock 기반 과다재고 보완 ─────────────
  //   vendor_inventory에 없는 상품만 대상
  const { data: products, error: prodErr } = await supabase
    .from('products')
    .select('id, stock, expiry_days')
    .eq('is_active', true)
    .gt('stock', OVERSTOCK_THRESHOLD);

  if (prodErr) throw prodErr;

  for (const p of products || []) {
    if (processedIds.has(p.id)) continue;

    const stock = Number(p.stock);
    const discountRate = stock >= 200 ? 30 : stock >= 150 ? 20 : 10;
    alerts.push({
      product_id:                p.id,
      alert_type:                '과다재고',
      current_stock:             stock,
      expiry_date:               null,
      recommended_discount_rate: discountRate,
      status:                    '대기',
    });
  }

  if (alerts.length === 0) {
    return { detected: 0, expiry: 0, overstock: 0, data: [] };
  }

  const { data: inserted, error: insErr } = await supabase
    .from('inventory_alerts')
    .insert(alerts)
    .select();

  if (insErr) throw insErr;

  return {
    detected:  inserted.length,
    expiry:    inserted.filter(a => a.alert_type === '유통기한임박').length,
    overstock: inserted.filter(a => a.alert_type === '과다재고').length,
    data:      inserted,
  };
}

module.exports = { calculateCustomerGrade, detectInventoryAlerts };
