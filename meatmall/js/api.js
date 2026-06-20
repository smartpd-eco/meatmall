/* ═══════════════════════════════════════════════════
   정육본가 — 프론트엔드 API 클라이언트
   실제 백엔드 서버와 통신하는 공통 모듈
═══════════════════════════════════════════════════ */

const API_BASE = 'http://localhost:3000/api'; // 배포 시 실제 도메인으로 변경

// ── Access Token 인메모리 관리 (XSS 방지 위해 localStorage 미사용)
let _accessToken = null;
let _user = null;

const Auth = {
  // ── 토큰 설정
  setToken(token) {
    _accessToken = token;
  },
  getToken() { return _accessToken; },

  // ── 유저 정보 관리
  setUser(user) {
    _user = user;
    // 비민감 정보만 localStorage에 캐싱 (새로고침 대비)
    try {
      localStorage.setItem('mm_user_cache', JSON.stringify({
        id: user.id, name: user.name, grade: user.grade, point: user.point, email: user.email
      }));
    } catch(e) {}
  },
  getUser() {
    if (_user) return _user;
    // 캐시에서 복원 (토큰은 없으므로 /refresh 필요)
    try {
      const cached = localStorage.getItem('mm_user_cache');
      return cached ? JSON.parse(cached) : null;
    } catch(e) { return null; }
  },
  isLoggedIn() { return !!_accessToken || !!localStorage.getItem('mm_user_cache'); },
  clear() {
    _accessToken = null;
    _user = null;
    localStorage.removeItem('mm_user_cache');
  }
};

// ── 기본 fetch 래퍼 (자동 토큰 갱신 포함)
async function apiFetch(path, options = {}) {
  const url = API_BASE + path;
  const headers = { 'Content-Type': 'application/json', ...options.headers };

  if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`;

  let res = await fetch(url, { ...options, headers, credentials: 'include' });

  // 401: Access Token 만료 → Refresh 시도
  if (res.status === 401 && !options._retry) {
    const refreshed = await refreshToken();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${_accessToken}`;
      res = await fetch(url, { ...options, headers, credentials: 'include', _retry: true });
    } else {
      // 재로그인 필요
      Auth.clear();
      window.location.href = '/login.html';
      return;
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '서버 오류'), { status: res.status, data });
  return data;
}

// ── Refresh Token으로 Access Token 갱신
async function refreshToken() {
  try {
    const res = await fetch(API_BASE + '/auth/refresh', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) return false;
    const data = await res.json();
    Auth.setToken(data.accessToken);
    if (data.user) Auth.setUser(data.user);
    return true;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════
// 인증 API
// ════════════════════════════════════════════
const AuthAPI = {
  // 이메일 회원가입
  async signup(payload) {
    const data = await apiFetch('/auth/signup', { method: 'POST', body: JSON.stringify(payload) });
    Auth.setToken(data.accessToken);
    Auth.setUser(data.user);
    return data;
  },

  // 이메일 로그인
  async login(email, password) {
    const data = await apiFetch('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password })
    });
    Auth.setToken(data.accessToken);
    Auth.setUser(data.user);
    return data;
  },

  // 소셜 로그인 시작 (서버로 리다이렉트)
  startKakao()  { window.location.href = API_BASE + '/auth/kakao'; },
  startNaver()  { window.location.href = API_BASE + '/auth/naver'; },
  startGoogle() { window.location.href = API_BASE + '/auth/google'; },

  // 소셜 콜백 처리 (social-callback.html 에서 호출)
  handleSocialCallback() {
    const params = new URLSearchParams(window.location.search);
    const token  = params.get('token');
    const name   = params.get('name');
    const grade  = params.get('grade');
    const point  = params.get('point');
    const error  = params.get('error');

    if (error) {
      const msgs = {
        kakao_failed: '카카오 로그인에 실패했습니다',
        naver_failed: '네이버 로그인에 실패했습니다',
        google_failed: '구글 로그인에 실패했습니다',
        inactive: '비활성화된 계정입니다. 고객센터에 문의해주세요'
      };
      return { ok: false, error: msgs[error] || '로그인 오류가 발생했습니다' };
    }

    if (token) {
      Auth.setToken(token);
      Auth.setUser({ name, grade, point: Number(point) });
      return { ok: true };
    }
    return { ok: false, error: '콜백 처리 오류' };
  },

  // 내 정보 조회
  async me() {
    const data = await apiFetch('/auth/me');
    if (data.user) Auth.setUser(data.user);
    return data.user;
  },

  // 로그아웃
  async logout() {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch(e) {}
    Auth.clear();
    window.location.href = '/login.html';
  },

  // 페이지 진입 시 로그인 상태 복원 (새로고침 대응)
  async init() {
    if (!_accessToken && Auth.isLoggedIn()) {
      await refreshToken();
    }
    return Auth.isLoggedIn();
  }
};

// 전역 노출
window.Auth    = Auth;
window.AuthAPI = AuthAPI;
window.apiFetch = apiFetch;
