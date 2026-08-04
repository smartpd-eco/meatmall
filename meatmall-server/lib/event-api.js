// ════════════════════════════════════════════════════
//  외부 행사정보 수집 — 한국관광공사 TourAPI(축제정보)
//  - EVENT_API_KEY(공공데이터포털 서비스키) 미설정 시 no_key 반환(무해).
//  - 실패/타임아웃 모두 안전 처리하여 호출측을 깨지 않음.
// ════════════════════════════════════════════════════
const fetch = require('node-fetch');

function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }
function toDate(s) { s = String(s || ''); return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null; }

async function fetchFestivals(days = 30) {
  const key = process.env.EVENT_API_KEY || process.env.TOUR_API_KEY;
  if (!key) return { ok: false, reason: 'no_key', items: [] };
  try {
    const start = ymd(new Date());
    const url = `https://apis.data.go.kr/B551011/KorService1/searchFestival1?serviceKey=${encodeURIComponent(key)}&MobileOS=ETC&MobileApp=meatmall&_type=json&arrange=A&numOfRows=100&pageNo=1&eventStartDate=${start}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, reason: 'http_' + r.status, items: [] };
    const d = await r.json();
    const raw = (((d.response || {}).body || {}).items || {}).item || [];
    const items = (Array.isArray(raw) ? raw : [raw]).map(it => ({
      ext_id: String(it.contentid || ''),
      title: it.title || '',
      lng: Number(it.mapx) || null,   // TourAPI mapx=경도
      lat: Number(it.mapy) || null,   // mapy=위도
      addr: it.addr1 || '',
      start_date: toDate(it.eventstartdate),
      end_date: toDate(it.eventenddate)
    })).filter(x => x.title && x.lat && x.lng);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'error', items: [] };
  }
}

module.exports = { fetchFestivals };
