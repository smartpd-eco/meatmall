// ════════════════════════════════════════════════════
//  레이어3(특허): 배송완료 시점 예상 품온(品溫) 예측 모듈
//  - 외기온 + 예상 배송시간 + 포장 보냉으로 도착 시점 상품온도를 예측,
//    콜드체인 임계 초과 거점/수단을 사전 제외.
//  - WEATHER_API_KEY 미설정 시 외기온 null → 게이트 자동 무력화(기존 무영향).
//  - 실패/타임아웃은 모두 null 반환하여 절대 호출측을 깨지 않음.
// ════════════════════════════════════════════════════
const fetch = require('node-fetch');

// 거리(km) → 예상 배송소요(분): 평균 25km/h + 15분 준비
function estimateEtaMin(km) {
  if (km == null || isNaN(km)) return null;
  return Math.round((km / 25) * 60) + 15;
}

// 뉴턴 승온 모델: 도착 품온 = 외기 + (초기 - 외기)·e^(-k·t)
//  initTempC     : 출고 시 상품온도(냉장육 기본 2℃)
//  kPerMin       : 승온계수(보냉 강할수록 작음). 기본 0.02(무보냉 근사)
function predictArrivalTemp({ extTempC, etaMin, initTempC = 2, kPerMin = 0.02 }) {
  if (extTempC == null || etaMin == null) return null;
  const t = extTempC + (initTempC - extTempC) * Math.exp(-kPerMin * etaMin);
  return Math.round(t * 10) / 10;
}

// 외기온(℃) 조회 — OpenWeather, 30분 캐시. 키 없거나 실패 시 null.
const _wCache = new Map();
async function getExternalTempC(lat, lng) {
  const key = process.env.WEATHER_API_KEY;
  if (!key || lat == null || lng == null) return null;
  const ck = `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
  const c = _wCache.get(ck);
  if (c && Date.now() - c.at < 30 * 60000) return c.t;
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${key}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    const t = d && d.main && d.main.temp;
    if (typeof t === 'number') { _wCache.set(ck, { t, at: Date.now() }); return t; }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = { predictArrivalTemp, getExternalTempC, estimateEtaMin };
