const express  = require('express');
const fetch    = require('node-fetch');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { signAccessToken, signRefreshToken } = require('../../lib/jwt');

const FRONTEND = 'https://smartpd-eco.github.io/meatmall';

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

  // 2. 이메일로 기존 계정 연결 (이메일 있을 때만)
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
      .insert({
        name: name || '회원',
        email: email || null,  // 이메일 없어도 OK
        point: 1000
      })
      .select('id')
      .single();
    if (error) throw error;
    userId = newUser.id;

    // 가입 포인트
    await supabase.from('point_logs').insert({
      user_id: userId, amount: 1000, reason: '소셜 가입 축하 포인트'
    });
  }

  // 4. 소셜 계정 연결
  await supabase.from('social_accounts').upsert({
    user_id: userId, provider, provider_id: String(providerId)
  }, { onConflict: 'provider,provider_id' });

  // 5. 최신 유저 정보 반환
  const { data: user } = await supabase
    .from('users')
    .select('id, email, name, grade, point, is_admin, is_active')
    .eq('id', userId)
    .single();

  return user;
}

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

  const params = new URLSearchParams({
    accessToken,
    name:  user.name  || '',
    grade: user.grade || 'BASIC',
    point: String(user.point || 0)
  });
  res.redirect(`${FRONTEND}/pages/social-callback.html?${params}`);
}

// ── 카카오 ──────────────────────────────────────────────
router.get('/kakao', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.KAKAO_CLIENT_ID,
    redirect_uri:  'https://meatmall-server.vercel.app/api/auth/kakao/callback',
    response_type: 'code',
    scope:         'profile_nickname'  // 이메일 제거 (비즈앱 아니면 불가)
  });
  res.redirect(`https://kauth.kakao.com/oauth/authorize?${params}`);
});

router.get('/kakao/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect(`${FRONTEND}/login.html?error=kakao_failed`);

    // 1. Access Token
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.KAKAO_CLIENT_ID,
        client_secret: process.env.KAKAO_CLIENT_SECRET || '',
        redirect_uri:  'https://meatmall-server.vercel.app/api/auth/kakao/callback',
        code
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('KAKAO_TOKEN_FAIL');

    // 2. 사용자 정보 (닉네임만)
    const profileRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();

    const kakaoId = profile.id;
    const name    = profile.kakao_account?.profile?.nickname || '카카오 회원';
    // 이메일: 비즈앱 아니면 null
    const email   = profile.kakao_account?.email || null;

    const user = await handleSocialUser({ provider: 'kakao', providerId: kakaoId, email, name });
    await finishSocialLogin(res, user);
  } catch (err) {
    console.error('[kakao/callback]', err);
    if (err.message === 'INACTIVE')
      return res.redirect(`${FRONTEND}/login.html?error=inactive`);
    res.redirect(`${FRONTEND}/login.html?error=kakao_failed`);
  }
});

// ── 네이버 ──────────────────────────────────────────────
router.get('/naver', (req, res) => {
  const state = Math.random().toString(36).slice(2);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.NAVER_CLIENT_ID,
    redirect_uri:  'https://meatmall-server.vercel.app/api/auth/naver/callback',
    state
  });
  res.redirect(`https://nid.naver.com/oauth2.0/authorize?${params}`);
});

router.get('/naver/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.redirect(`${FRONTEND}/login.html?error=naver_failed`);

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

    const profileRes = await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profileData = await profileRes.json();
    const profile = profileData.response;

    const user = await handleSocialUser({
      provider: 'naver',
      providerId: profile.id,
      email: profile.email || null,
      name:  profile.name || profile.nickname || '네이버 회원'
    });
    await finishSocialLogin(res, user);
  } catch (err) {
    console.error('[naver/callback]', err);
    res.redirect(`${FRONTEND}/login.html?error=naver_failed`);
  }
});

// ── 구글 ────────────────────────────────────────────────
router.get('/google', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  'https://meatmall-server.vercel.app/api/auth/google/callback',
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', async (req, res) => {
  try {
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    console.log('[google] CLIENT_SECRET 존재여부:', !!clientSecret);
    if (!clientSecret) {
      return res.redirect(`${FRONTEND}/pages/login.html?error=google_config`);
    }

    const { code } = req.query;
    if (!code) return res.redirect(`${FRONTEND}/login.html?error=google_failed`);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  'https://meatmall-server.vercel.app/api/auth/google/callback',
        grant_type:    'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('GOOGLE_TOKEN_FAIL');

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
    console.error('[google/callback] 상세에러:', err.message, err.stack);
    res.redirect(`${FRONTEND}/login.html?error=google_failed`);
  }
});

module.exports = router;
