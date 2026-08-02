// ════════════════════════════════════════════════════
//  레이어2(특허): 정육점 가공여력(설비·인력·작업대기열·예상 가공시간) 평가 모듈
//  - "재고 보유"가 아니라 "마감 내 실제 가공·출고 가능한 여력"을 산출.
//  - 입력 컬럼(avg_prep_min, prep_parallel)이 없으면 기본값으로 보수적 추정 → 무해 폴백.
//  - 순수 계산만 하며 기존 로직에 영향 없음.
// ════════════════════════════════════════════════════

// 당일 마감시간(KST 'HH:MM')까지 남은 분
function minutesToCutoff(cutoff) {
  const nowKst = new Date(Date.now() + 9 * 3600 * 1000);
  const hm = String(cutoff || '14:00').slice(0, 5).split(':');
  const cut = new Date(nowKst);
  cut.setUTCHours(Number(hm[0]) || 14, Number(hm[1]) || 0, 0, 0);
  return (cut.getTime() - nowKst.getTime()) / 60000;
}

// 가공여력 평가 → { exclude, score(0~25), available }
//  avg_prep_min  : 건당 예상 가공시간(분)  — 기본 20
//  prep_parallel : 동시 처리 가능 작업대/인력 수 — 기본 1
//  daily_order_limit : 일일 처리한도 — 기본 50
//  todayCount    : 오늘 이미 배정된 발주 수(작업대기열 반영)
//  same_day_cutoff : 당일 마감시간
function evalCapacity(v) {
  const prep = Number(v.avg_prep_min) || 20;
  const parallel = Math.max(1, Number(v.prep_parallel) || 1);
  const maxDaily = Number(v.daily_order_limit) || 50;
  const todayCount = Number(v.todayCount || 0);
  const remainMin = minutesToCutoff(v.same_day_cutoff || '14:00');

  // 마감까지 설비·인력으로 처리 가능한 추가 건수
  const byTime = remainMin <= 0 ? 0 : Math.floor((remainMin / prep) * parallel);
  // 일일 한도 잔여(이미 밀린 작업량 반영)
  const byLimit = Math.max(0, maxDaily - todayCount);

  const available = Math.min(byTime, byLimit);
  if (available <= 0) return { exclude: true, score: 0, available };
  return { exclude: false, score: Math.min(25, available * 3), available };
}

module.exports = { evalCapacity, minutesToCutoff };
