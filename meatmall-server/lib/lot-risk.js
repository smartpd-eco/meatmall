// ════════════════════════════════════════════════════
//  레이어1(특허): 로트 폐기위험도 산출 모듈
//  - product_lots(로트별 유통기한·잔여수량)가 있으면 로트 기준,
//    없으면 products.expiry_days 로 보수적 근사(폴백).
//  - 반환: 0~1 (높을수록 폐기임박/과잉재고 → 우선 소진 대상)
//  - 이 모듈은 순수 계산만 하며 기존 로직에 영향 없음.
// ════════════════════════════════════════════════════

function daysUntil(ts) {
  if (!ts) return null;
  return (new Date(ts).getTime() - Date.now()) / 86400000;
}

// 단일 로트 위험도
function lotRisk(lot) {
  const d = daysUntil(lot.expiry_at);
  // 유통기한 임박할수록 위험↑ (7일 기준 선형, 0일 이하=1)
  const expiryRisk = d == null ? 0.3 : d <= 0 ? 1 : d >= 7 ? 0.05 : 1 - d / 7;
  // 잔여수량 많을수록 소진 압박↑ (50개 기준 정규화)
  const remain = Number(lot.qty_remaining || 0);
  const stockRisk = remain <= 0 ? 0 : Math.min(1, remain / 50);
  return Math.min(1, 0.7 * expiryRisk + 0.3 * stockRisk);
}

// 상품 단위 폐기위험도 (활성 로트 중 최댓값, 없으면 expiry_days 근사)
function productWasteRisk(product, lots) {
  if (Array.isArray(lots) && lots.length) {
    return Math.round(Math.max(...lots.map(lotRisk)) * 100) / 100;
  }
  // 폴백: 로트 데이터 미입력 시 상품 유통일수·재고로 근사
  const ed = Number(product && product.expiry_days || 0);
  const expiryRisk = !ed ? 0.2 : ed <= 1 ? 0.9 : ed >= 7 ? 0.1 : 1 - ed / 7;
  const stockRisk = Math.min(1, Number(product && product.stock || 0) / 50);
  return Math.round((0.7 * expiryRisk + 0.3 * stockRisk) * 100) / 100;
}

module.exports = { productWasteRisk, lotRisk };
