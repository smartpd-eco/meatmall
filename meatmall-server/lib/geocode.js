// 카카오 Local API 기반 주소→좌표 변환 + 직선거리 유틸
// KAKAO_REST_API_KEY(Vercel 환경변수) 없으면 null 반환 → 호출부에서 안전 폴백
const fetch = require('node-fetch');

async function kakaoGeocode(address) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key || !address) return null;
  try {
    const url = 'https://dapi.kakao.com/v2/local/search/address.json?query=' + encodeURIComponent(address);
    const r = await fetch(url, { headers: { Authorization: 'KakaoAK ' + key } });
    if (!r.ok) return null;
    const d = await r.json();
    const doc = d.documents && d.documents[0];
    if (!doc) return null;
    const lat = parseFloat(doc.y), lng = parseFloat(doc.x);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { lat, lng };
  } catch (e) {
    console.error('[kakaoGeocode]', e.message);
    return null;
  }
}

// 두 좌표 간 직선거리(km)
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

module.exports = { kakaoGeocode, haversineKm };
