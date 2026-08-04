// ════════════════════════════════════════════════════
//  행사별 수요 추정(AI 센스) — 축제 성격 → 추천 축종/부위/수량
//  ※ 정밀 통계가 아니라, 축제 먹거리 소비의 일반적 패턴에 근거한 '추정'입니다.
//     (지역 축제 노점·먹거리부스 구이/안주 소비 경향 기준)
// ════════════════════════════════════════════════════

// 우선순위 순서대로 첫 매칭 채택
const RULES = [
  { key: 'meat', kw: /한우|한돈|축산|정육|미트|불고기|삼겹살축제|바베?큐|BBQ|고기축제|갈비/i,
    cat: '축산·고기 직접형', species: '한우·한돈', cut: '갈비·등심 / 삼겹·목살', level: 3, qty: 20,
    reason: '고기가 행사 주제 자체라 구이·직판 수요가 크게 몰립니다. 프리미엄 부위(갈비·등심)와 대중 구이(삼겹·목살)를 함께 배치.' },
  { key: 'flower', kw: /벚꽃|꽃축제|봄축제|가을|단풍|캠핑|나들이|피크닉|유채/i,
    cat: '봄·나들이형', species: '한돈', cut: '삼겹살·오겹살', level: 3, qty: 16,
    reason: '야외 바베큐·나들이 수요가 집중되는 시기로 삼겹·오겹 구이 소비가 급증합니다.' },
  { key: 'sea', kw: /포구|갯|수산|어항|항축제|해산물|조개|젓갈|바다|해변|해수욕|물축제/i,
    cat: '해산물·포구형', species: '한돈', cut: '삼겹·목살(꼬치·구이)', level: 2, qty: 8,
    reason: '해산물이 주력인 행사지만, 먹거리 부스의 구이·안주 보조 수요로 삼겹·목살이 함께 소비됩니다.' },
  { key: 'trad', kw: /전통|김장|한마당|장터|먹거리|보쌈|국밥|향토|민속/i,
    cat: '전통·먹거리형', species: '한돈', cut: '앞다리·삼겹(수육·보쌈)', level: 2, qty: 12,
    reason: '수육·보쌈·국밥 등 삶는 조리 수요가 커, 앞다리·삼겹 물량을 우선 확보.' },
  { key: 'night', kw: /음악|재즈|락|밴드|드론|빛|라이트|불꽃|공연|예술|문화제|야시장|맥주|비어/i,
    cat: '문화·야간형', species: '한돈·계육', cut: '목살·삼겹 / 닭꼬치', level: 2, qty: 12,
    reason: '야간 먹거리·주류 소비가 많아 꼬치·구이류 회전이 빠릅니다. 목살·삼겹과 닭(꼬치)을 병행 추천.' },
  { key: 'sport', kw: /마라톤|체육|스포츠|경기|대회|리그|축구|야구/i,
    cat: '스포츠·체육형', species: '계육', cut: '닭가슴살·닭고기(도시락)', level: 1, qty: 6,
    reason: '단체 도시락·간편식 수요 위주로 육류는 보조적입니다. 닭가슴살 등 단백 위주 소량 대비.' },
];

const DEFAULT = { cat: '일반 지역축제형', species: '한돈', cut: '삼겹살·목살(범용 구이)', level: 2, qty: 10,
  reason: '지역 축제 먹거리 부스의 범용 구이 수요를 기준으로 삼겹·목살을 표준 배치.' };

const LEVEL_LABEL = { 3: '높음', 2: '보통', 1: '낮음' };

function inferDemand(ev) {
  const text = `${ev.title || ''} ${ev.addr || ''}`;
  const hit = RULES.find(r => r.kw.test(text)) || DEFAULT;
  return {
    category: hit.cat,
    species: hit.species,
    cut: hit.cut,
    level: hit.level,
    level_label: LEVEL_LABEL[hit.level] || '보통',
    suggest_qty: hit.qty,
    reason: hit.reason
  };
}

module.exports = { inferDemand };
