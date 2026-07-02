const CACHE_NAME = 'jeongyuk-v20260703a';
const CACHE_URLS = [
  '/meatmall/',
  '/meatmall/index.html',
  '/meatmall/css/main.css',
  '/meatmall/js/app.js',
  '/meatmall/js/api.js',
  '/meatmall/images/logo2.png',
];

/* ── 설치: 지정 파일 사전 캐시 ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
});

/* ── 활성화: 이전 버전 캐시 자동 삭제 ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── skipWaiting 메시지 수신 ── */
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

/* ── 요청 가로채기: Cache First 전략 ── */
self.addEventListener('fetch', event => {
  const url = event.request.url;

  /* API 요청은 캐시 없이 항상 네트워크 */
  if (
    url.includes('meatmall-server.vercel.app') ||
    url.includes('meatmall.vercel.app') ||
    url.includes('supabase.co')
  ) {
    return;
  }

  /* GET 요청만 캐시 전략 적용 */
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).catch(() => {
        /* 오프라인 시 index.html 폴백 */
        if (event.request.mode === 'navigate') {
          return caches.match('/meatmall/index.html');
        }
      });
    })
  );
});
