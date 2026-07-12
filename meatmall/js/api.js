/* ═══════════════════════════════════════════════════
   정육본가 — 프론트엔드 API 클라이언트
   실제 백엔드 서버 연결 완료
═══════════════════════════════════════════════════ */

const API_BASE = 'https://api.meatbonga.com/api';

let _accessToken = null;
let _user = null;

const Auth = {
  setToken(token) { _accessToken = token; },
  getToken() { return _accessToken; },
  setUser(user) {
    _user = user;
    try {
      localStorage.setItem('mm_user_cache', JSON.stringify({
        id: user.id, name: user.name, grade: user.grade,
        point: user.point, email: user.email
      }));
    } catch(e) {}
  },
  getUser() {
    if (_user) return _user;
    try {
      const cached = localStorage.getItem('mm_user_cache');
      return cached ? JSON.parse(cached) : null;
    } catch(e) { return null; }
  },
  isLoggedIn() { return !!_accessToken || !!localStorage.getItem('mm_user_cache'); },
  clear() {
    _accessToken = null;
    _user = null;
    localStorage.removeItem('mm_access_token');
    localStorage.removeItem('mm_token');
    localStorage.removeItem('mm_user_cache');
    localStorage.removeItem('mm_last_active');
  }
};

async function apiFetch(path, options = {}) {
  const url = API_BASE + path;
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`;

  let res = await fetch(url, { ...options, headers, credentials: 'include' });

  if (res.status === 401 && !options._retry) {
    const refreshed = await refreshToken();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${_accessToken}`;
      res = await fetch(url, { ...options, headers, credentials: 'include', _retry: true });
    } else {
      Auth.clear();
      window.location.href = location.pathname.indexOf('/meatmall/') === 0 ? '/meatmall/login.html' : '/login.html';
      return;
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '서버 오류'), { status: res.status, data });
  return data;
}

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
  } catch { return false; }
}

const AuthAPI = {
  async signup(payload) {
    const data = await apiFetch('/auth/signup', { method: 'POST', body: JSON.stringify(payload) });
    Auth.setToken(data.accessToken);
    Auth.setUser(data.user);
    return data;
  },

  async login(email, password) {
    const data = await apiFetch('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password })
    });
    Auth.setToken(data.accessToken);
    Auth.setUser(data.user);
    return data;
  },

  startKakao()  { window.location.href = API_BASE + '/auth/kakao'; },
  startNaver()  { window.location.href = API_BASE + '/auth/naver'; },
  startGoogle() { window.location.href = API_BASE + '/auth/google'; },

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

  async me() {
    const data = await apiFetch('/auth/me');
    if (data.user) Auth.setUser(data.user);
    return data.user;
  },

  async logout() {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch(e) {}
    Auth.clear();
    window.location.href = location.pathname.indexOf('/meatmall/') === 0 ? '/meatmall/login.html' : '/login.html';
  },

  async init() {
    if (!_accessToken && Auth.isLoggedIn()) {
      await refreshToken();
    }
    return Auth.isLoggedIn();
  }
};

window.Auth    = Auth;
window.AuthAPI = AuthAPI;
window.apiFetch = apiFetch;
