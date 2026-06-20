const express  = require('express');
const fetch    = require('node-fetch');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { signAccessToken, signRefreshToken } = require('../../lib/jwt');

const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5500';

// ── 공통: 소셜 로그인 후 사용자 처리 (신규 가입 or 기존 로그인)
async function handleSocialUser({ provider, providerId, email, name }) {
  // 1. 기존 소셜 계정 확인
  const { data: existing } = await supabase
    .from('social_accounts')
    .select('user_id, users(id, email, name, grade, point, is_admin, is_active)')
    .eq('provider', provider)
    .eq('provider_id', String(providerId))
    .single();

  if (existing?.users) {
    if (!existing.users.is_active) throw new Error('INACTIVE');
    return existing.users;
  }

  // 2. 이메일로 기존 계정 연결 시도
  let userId;
  if (email) {
    const { data: byEmail } = await supabase
      .from('users').select('id').eq('email', email).single();
    if (byEmail) userId = byEmail.id;
  }

  // 3. 신규 사용자 생성
  if (!userId) {
    const { data: newUser, error } = await supabase
      .from('users')
      .insert({ name: name || '회원', email: email || null, point: 1000 })
      .select('id')
      .single();
    if (error) throw error;
    userId = newUser.id;

    // 신규 가입 포인트
    await supabase.from('point_logs').insert({
      user_id: userId, amount: 1000, reason: '소셜 가입 축하 포인트'
    });
  }

  // 4. 소셜 계정 연결
  await supabase.from('social_accounts').upsert({
    user_id: userId, provider, provider_id: String(providerId)
  }, { onConflict: 'provider,provider_id' });

  // 5. 최신 사용자 정보 반환
  const { data: user } = await supabase
    .from('users')
    .select('id, email, name, grade, point, is_admin, is_active')
    .eq('id', userId)
    .single();

  return user;
}

// ── 소셜 로그인 완료 후 프론트로 리다이렉트 (토큰 전달)
async function finishSocialLogin(res, user) {
  const accessToken = signAccessToken(user);
  const { token: refreshToken, expiresAt } = await signRefreshToken(user.id);

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/api/auth'
  });

  // 프론트엔드로 리다이렉트 (해시로 accessToken 전달)
  const params = new URLSearchParams({
    token: accessToken,
    name: user.name || '',
    grade: user.grade || 'BASIC',
    point: String(user.point || 0)
  });
  res.redirect(`${FRONTEND}/pages/social-callback.html?${params}`);
}

// ════════════════════════════════════════════
// 카카오 OAuth
// ════════════════════════════════════════════
router.get('/kakao', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.KAKAO_CLIENT_ID,
    redirect_uri:  process.env.KAKAO_REDIRECT_URI,
    response_type: 'code',
    scope:         'profile_nickname,account_email'
  });
  res.redirect(`https://kauth.kakao.com/oauth/authorize?${params}`);
});

router.get('/kakao/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect(`${FRONTEND}/login.html?error=kakao_failed`);

    // 1. 인가 코드 → Access Token
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.KAKAO_CLIENT_ID,
        client_secret: process.env.KAKAO_CLIENT_SECRET || '',
        redirect_uri:  process.env.KAKAO_REDIRECT_URI,
        code
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('KAKAO_TOKEN_FAIL');

    // 2. 사용자 정보 조회
    const profileRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();

    const kakaoId = profile.id;
    const email   = profile.kakao_account?.email || null;
    const name    = profile.kakao_account?.profile?.nickname || '카카오 회원';

    const user = await handleSocialUser({ provider: 'kakao', providerId: kakaoId, email, name });
    await finishSocialLogin(res, user);
  } catch (err) {
    console.error('[kakao/callback]', err);
    if (err.message === 'INACTIVE')
      return res.redirect(`${FRONTEND}/login.html?error=inactive`);
    res.redirect(`${FRONTEND}/login.html?error=kakao_failed`);
  }
});

// ════════════════════════════════════════════
// 네이버 OAuth
// ════════════════════════════════════════════
router.get('/naver', (req, res) => {
  const state = Math.random().toString(36).slice(2);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.NAVER_CLIENT_ID,
    redirect_uri:  process.env.NAVER_REDIRECT_URI,
    state
  });
  res.redirect(`https://nid.naver.com/oauth2.0/authorize?${params}`);
});

router.get('/naver/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.redirect(`${FRONTEND}/login.html?error=naver_failed`);

    // 1. Access Token
    const tokenRes = await fetch('https://nid.naver.com/oauth2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.NAVER_CLIENT_ID,
        client_secret: process.env.NAVER_CLIENT_SECRET,
        code, state
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('NAVER_TOKEN_FAIL');

    // 2. 사용자 정보
    const profileRes = await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profileData = await profileRes.json();
    const profile = profileData.response;

    const user = await handleSocialUser({
      provider: 'naver',
      providerId: profile.id,
      email: profile.email || null,
      name:  profile.name  || profile.nickname || '네이버 회원'
    });
    await finishSocialLogin(res, user);
  } catch (err) {
    console.error('[naver/callback]', err);
    res.redirect(`${FRONTEND}/login.html?error=naver_failed`);
  }
});

// ════════════════════════════════════════════
// 구글 OAuth
// ════════════════════════════════════════════
router.get('/google', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect(`${FRONTEND}/login.html?error=google_failed`);

    // 1. Access Token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('GOOGLE_TOKEN_FAIL');

    // 2. 사용자 정보
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();

    const user = await handleSocialUser({
      provider: 'google',
      providerId: profile.id,
      email: profile.email || null,
      name:  profile.name  || '구글 회원'
    });
    await finishSocialLogin(res, user);
  } catch (err) {
    console.error('[google/callback]', err);
    res.redirect(`${FRONTEND}/login.html?error=google_failed`);
  }
});

module.exports = router;
