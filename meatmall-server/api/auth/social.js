const express  = require('express');
const fetch    = require('node-fetch');
const bcrypt   = require('bcryptjs');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { signAccessToken, signRefreshToken, signLinkToken, verifyLinkToken } = require('../../lib/jwt');

const FRONTEND = 'https://meatbonga.com';

// ── 소셜 로그인 사용자 확인/생성
// 반환: { status: 'ok', user }  또는  { status: 'link_required', linkToken, existingEmail, reauthMethod }
async function resolveSocialUser({ provider, providerId, email, name }) {
  email = email ? String(email).trim().toLowerCase() : null;
  // 1. 이미 이 소셜 계정으로 연동된 유저가 있으면 정상 로그인
  const { data: existing } = await supabase
    .from('social_accounts')
    .select('user_id, users(id, email, name, phone, grade, point, is_admin, is_active, vendor_id, role)')
    .eq('provider', provider)
    .eq('provider_id', String(providerId))
    .single();

  if (existing?.users) {
    if (!existing.users.is_active) throw new Error('INACTIVE');
    return { status: 'ok', user: existing.users };
  }

  // 2. 이메일로 기존 계정이 있는지 확인 (이메일이 제공된 경우만 — 카카오 등 이메일 미동의 시 스킵)
  if (email) {
    const { data: byEmailRows, error: byEmailError } = await supabase
      .from('users')
      .select('id, email, password_hash, is_active')
      .ilike('email', email)
      .limit(1);
    if (byEmailError) throw byEmailError;
    const byEmail = byEmailRows?.[0];

    if (byEmail) {
      if (!byEmail.is_active) throw new Error('INACTIVE');

      const { data: linkedAccounts } = await supabase
        .from('social_accounts')
        .select('provider, provider_id')
        .eq('user_id', byEmail.id);

      let reauthMethod = null, reauthProviderId = null;
      if (byEmail.password_hash) {
        reauthMethod = 'password';
      } else if (linkedAccounts && linkedAccounts.length) {
        reauthMethod = linkedAccounts[0].provider;
        reauthProviderId = linkedAccounts[0].provider_id;
      }

      // 재인증 가능한 기존 가입수단이 있으면 즉시 연동하지 않고 확인 절차로 유도
      if (reauthMethod) {
        const linkToken = signLinkToken({
          existingUserId: byEmail.id,
          newProvider: provider,
          newProviderId: String(providerId),
          reauthMethod,
          reauthProviderId
        });
        return { status: 'link_required', linkToken, existingEmail: byEmail.email, reauthMethod };
      }
      // reauthMethod가 없는(가입수단이 전혀 없는) 예외 상황은 안전하게 신규 계정 생성으로 폴백
    }
  }

  // 3. 신규 사용자 생성
  const { data: newUser, error } = await supabase
    .from('users')
    .insert({ name: name || '회원', email: email || null, point: 1000 })
    .select('id')
    .single();
  if (error) throw error;
  const userId = newUser.id;

  const { error: pointError } = await supabase.from('point_logs').insert({
    user_id: userId, amount: 1000, reason: '소셜 가입 축하 포인트'
  });
  if (pointError) {
    await supabase.from('users').delete().eq('id', userId);
    throw pointError;
  }

  const { error: socialError } = await supabase.from('social_accounts').upsert({
    user_id: userId, provider, provider_id: String(providerId)
  }, { onConflict: 'provider,provider_id' });
  if (socialError) {
    await supabase.from('users').delete().eq('id', userId);
    throw socialError;
  }

  const { data: user } = await supabase
    .from('users')
    .select('id, email, name, phone, grade, point, is_admin, is_active, vendor_id, role')
    .eq('id', userId)
    .single();

  return { status: 'ok', user };
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
    point: String(user.point || 0),
    needsPhone: (!user.phone) ? 'true' : 'false',
    vendor: user.vendor_id ? '1' : ''
  });
  res.redirect(`${FRONTEND}/pages/social-callback.html?${params}`);
}

function redirectToLinkPage(res, result, newProvider) {
  const params = new URLSearchParams({
    token: result.linkToken,
    email: result.existingEmail || '',
    reauthMethod: result.reauthMethod,
    newProvider
  });
  res.redirect(`${FRONTEND}/pages/link-account.html?${params}`);
}

// ── 재인증(relink) 콜백 공통 처리: 기존 가입수단으로 재인증 성공 시 새 소셜 계정을 연결
async function handleRelinkCallback(res, linkToken, reauthProvider, reauthProviderIdFromCallback) {
  const payload = verifyLinkToken(linkToken);
  if (!payload || payload.reauthMethod !== reauthProvider) {
    return res.redirect(`${FRONTEND}/login.html?error=relink_invalid`);
  }
  if (String(payload.reauthProviderId) !== String(reauthProviderIdFromCallback)) {
    // 기존에 연동된 그 계정이 아니라 같은 제공자의 다른 계정으로 재인증한 경우 — 연동 거부
    return res.redirect(`${FRONTEND}/login.html?error=relink_mismatch`);
  }

  await supabase.from('social_accounts').upsert({
    user_id: payload.existingUserId,
    provider: payload.newProvider,
    provider_id: payload.newProviderId
  }, { onConflict: 'provider,provider_id' });

  const { data: user } = await supabase
    .from('users')
    .select('id, email, name, phone, grade, point, is_admin, is_active, vendor_id, role')
    .eq('id', payload.existingUserId)
    .single();

  if (!user || !user.is_active) return res.redirect(`${FRONTEND}/login.html?error=inactive`);
  await finishSocialLogin(res, user);
}

// ── 비밀번호 재인증으로 계정 연동 (이메일/비밀번호로 가입했던 계정용)
router.post('/relink/verify-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password)
      return res.status(400).json({ error: '토큰과 비밀번호가 필요합니다' });

    const payload = verifyLinkToken(token);
    if (!payload || payload.reauthMethod !== 'password')
      return res.status(400).json({ error: '유효하지 않거나 만료된 요청입니다' });

    const { data: user } = await supabase
      .from('users')
      .select('id, email, name, phone, password_hash, grade, point, is_admin, is_active')
      .eq('id', payload.existingUserId)
      .single();

    if (!user || !user.password_hash)
      return res.status(401).json({ error: '비밀번호가 올바르지 않습니다' });
    if (!user.is_active)
      return res.status(403).json({ error: '비활성화된 계정입니다. 고객센터에 문의해주세요' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: '비밀번호가 올바르지 않습니다' });

    await supabase.from('social_accounts').upsert({
      user_id: payload.existingUserId,
      provider: payload.newProvider,
      provider_id: payload.newProviderId
    }, { onConflict: 'provider,provider_id' });

    const accessToken = signAccessToken(user);
    const { token: refreshToken, expiresAt } = await signRefreshToken(user.id);
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
      path: '/api/auth'
    });

    const { password_hash: _, ...safeUser } = user;
    res.json({ ok: true, user: safeUser, accessToken });
  } catch (err) {
    console.error('[relink/verify-password]', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// ── 카카오 ──────────────────────────────────────────────
router.get('/kakao', (req, res) => {
  const { relink } = req.query;
  const params = new URLSearchParams({
    client_id:     process.env.KAKAO_CLIENT_ID,
    redirect_uri:  'https://api.meatbonga.com/api/auth/kakao/callback',
    response_type: 'code',
    scope:         'profile_nickname account_email'  // account_email: 카카오 비즈앱 승인 시 이메일 제공 → 이메일 기반 중복가입 방지 자동 작동
  });
  if (relink) params.set('state', 'relink:' + relink);
  res.redirect(`https://kauth.kakao.com/oauth/authorize?${params}`);
});

router.get('/kakao/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.redirect(`${FRONTEND}/login.html?error=kakao_failed`);

    // 1. Access Token
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.KAKAO_CLIENT_ID,
        client_secret: process.env.KAKAO_CLIENT_SECRET || '',
        redirect_uri:  'https://api.meatbonga.com/api/auth/kakao/callback',
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
    // 이메일: 비즈앱 아니면 null → 자동 연동 불가, 신규 계정으로 생성 (추후 마이페이지에서 수동 연동 가능하도록 social_accounts 구조는 이미 지원)
    const email   = profile.kakao_account?.email || null;

    if (state && state.startsWith('relink:')) {
      return await handleRelinkCallback(res, state.slice(7), 'kakao', String(kakaoId));
    }

    const result = await resolveSocialUser({ provider: 'kakao', providerId: kakaoId, email, name });
    if (result.status === 'link_required') return redirectToLinkPage(res, result, 'kakao');
    await finishSocialLogin(res, result.user);
  } catch (err) {
    console.error('[kakao/callback]', err);
    if (err.message === 'INACTIVE')
      return res.redirect(`${FRONTEND}/login.html?error=inactive`);
    res.redirect(`${FRONTEND}/login.html?error=kakao_failed`);
  }
});

// ── 네이버 ──────────────────────────────────────────────
router.get('/naver', (req, res) => {
  const { relink } = req.query;
  const state = relink ? ('relink:' + relink) : Math.random().toString(36).slice(2);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.NAVER_CLIENT_ID,
    redirect_uri:  'https://api.meatbonga.com/api/auth/naver/callback',
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

    if (state && state.startsWith('relink:')) {
      return await handleRelinkCallback(res, state.slice(7), 'naver', String(profile.id));
    }

    const result = await resolveSocialUser({
      provider: 'naver',
      providerId: profile.id,
      email: profile.email || null,
      name:  profile.name || profile.nickname || '네이버 회원'
    });
    if (result.status === 'link_required') return redirectToLinkPage(res, result, 'naver');
    await finishSocialLogin(res, result.user);
  } catch (err) {
    console.error('[naver/callback]', err);
    if (err.message === 'INACTIVE')
      return res.redirect(`${FRONTEND}/login.html?error=inactive`);
    res.redirect(`${FRONTEND}/login.html?error=naver_failed`);
  }
});

// ── 구글 ────────────────────────────────────────────────
router.get('/google', (req, res) => {
  const { relink } = req.query;
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  'https://api.meatbonga.com/api/auth/google/callback',
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline'
  });
  if (relink) params.set('state', 'relink:' + relink);
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', async (req, res) => {
  try {
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientSecret) {
      return res.redirect(`${FRONTEND}/pages/login.html?error=google_config`);
    }

    const { code, state } = req.query;
    if (!code) return res.redirect(`${FRONTEND}/login.html?error=google_failed`);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  'https://api.meatbonga.com/api/auth/google/callback',
        grant_type:    'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('GOOGLE_TOKEN_FAIL');

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();

    if (state && state.startsWith('relink:')) {
      return await handleRelinkCallback(res, state.slice(7), 'google', String(profile.id));
    }

    const result = await resolveSocialUser({
      provider: 'google',
      providerId: profile.id,
      email: profile.email || null,
      name:  profile.name  || '구글 회원'
    });
    if (result.status === 'link_required') return redirectToLinkPage(res, result, 'google');
    await finishSocialLogin(res, result.user);
  } catch (err) {
    console.error('[google/callback] 상세에러:', err.message, err.stack);
    if (err.message === 'INACTIVE')
      return res.redirect(`${FRONTEND}/login.html?error=inactive`);
    res.redirect(`${FRONTEND}/login.html?error=google_failed`);
  }
});

module.exports = router;
