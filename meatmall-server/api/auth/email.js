const express  = require('express');
const bcrypt   = require('bcryptjs');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { signAccessToken, signRefreshToken, rotateRefreshToken, revokeAllTokens } = require('../../lib/jwt');
const { requireAuth } = require('../../middleware/auth');

// ── 응답 헬퍼: 쿠키에 refresh token 저장
function setRefreshCookie(res, token, expiresAt) {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/api/auth'
  });
}

// ════════════════════════════════════════════
// POST /api/auth/signup — 이메일 회원가입
// ════════════════════════════════════════════
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, phone, marketing_agree, push_agree } = req.body;

    // 입력 검증
    if (!name || !email || !password)
      return res.status(400).json({ error: '이름, 이메일, 비밀번호는 필수입니다' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: '올바른 이메일 형식이 아닙니다' });
    if (password.length < 8)
      return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });

    // 중복 이메일 확인
    const { data: existing } = await supabase
      .from('users').select('id').eq('email', email).single();
    if (existing)
      return res.status(409).json({ error: '이미 사용 중인 이메일입니다' });

    // 비밀번호 해싱
    const password_hash = await bcrypt.hash(password, 12);

    // 사용자 생성
    const { data: user, error } = await supabase
      .from('users')
      .insert({ name, email, password_hash, phone: phone || null, marketing_agree: !!marketing_agree, push_agree: !!push_agree })
      .select('id, email, name, grade, point, is_admin')
      .single();

    if (error) throw error;

    // 가입 축하 포인트 1,000P
    await supabase.from('point_logs').insert({
      user_id: user.id, amount: 1000, reason: '회원가입 축하 포인트'
    });
    await supabase.from('users').update({ point: 1000 }).eq('id', user.id);
    user.point = 1000;

    // 토큰 발급
    const accessToken  = signAccessToken(user);
    const { token: refreshToken, expiresAt } = await signRefreshToken(user.id);
    setRefreshCookie(res, refreshToken, expiresAt);

    res.status(201).json({ ok: true, user: { id: user.id, name: user.name, email: user.email, grade: user.grade, point: user.point }, accessToken });
  } catch (err) {
    console.error('[signup]', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// ════════════════════════════════════════════
// POST /api/auth/login — 이메일 로그인
// ════════════════════════════════════════════
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요' });

    // 사용자 조회
    const { data: user } = await supabase
      .from('users')
      .select('id, email, name, password_hash, grade, point, is_admin, is_active')
      .eq('email', email)
      .single();

    if (!user || !user.password_hash)
      return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' });

    if (!user.is_active)
      return res.status(403).json({ error: '비활성화된 계정입니다. 고객센터에 문의해주세요' });

    // 비밀번호 검증
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' });

    // 토큰 발급
    const accessToken  = signAccessToken(user);
    const { token: refreshToken, expiresAt } = await signRefreshToken(user.id);
    setRefreshCookie(res, refreshToken, expiresAt);

    const { password_hash: _, ...safeUser } = user;
    res.json({ ok: true, user: safeUser, accessToken });
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// ════════════════════════════════════════════
// POST /api/auth/refresh — Access Token 갱신
// ════════════════════════════════════════════
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token || req.body?.refresh_token;
    if (!refreshToken)
      return res.status(401).json({ error: '리프레시 토큰이 없습니다' });

    const result = await rotateRefreshToken(refreshToken);
    if (!result)
      return res.status(401).json({ error: '토큰이 만료되었습니다. 다시 로그인해주세요' });

    setRefreshCookie(res, result.refreshToken, result.expiresAt);
    res.json({ ok: true, accessToken: result.accessToken, user: result.user });
  } catch (err) {
    console.error('[refresh]', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// ════════════════════════════════════════════
// POST /api/auth/logout — 로그아웃
// ════════════════════════════════════════════
router.post('/logout', requireAuth, async (req, res) => {
  try {
    await revokeAllTokens(req.user.sub);
    res.clearCookie('refresh_token', { path: '/api/auth' });
    res.json({ ok: true, message: '로그아웃 되었습니다' });
  } catch (err) {
    console.error('[logout]', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// ════════════════════════════════════════════
// POST /api/auth/phone — 전화번호 등록 (소셜 로그인 후 전화번호 필수 등록 플로우)
// ════════════════════════════════════════════
const PHONE_RE = /^010-\d{4}-\d{4}$/;

// TODO: PASS 본인인증 API 연동 필요 - 다날 또는 KG이니시스 계약 후 여기에 연동.
// 계약 전까지는 형식 검증만 통과하면 인증된 것으로 간주하는 임시 처리.
async function verifyPhoneWithPASS(phone) {
  return { verified: true };
}

router.post('/phone', requireAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !PHONE_RE.test(phone))
      return res.status(400).json({ error: '전화번호 형식이 올바르지 않습니다 (010-0000-0000)' });

    const passResult = await verifyPhoneWithPASS(phone);
    if (!passResult.verified)
      return res.status(400).json({ error: '본인인증에 실패했습니다' });

    // 중복가입 방지: 다른 계정이 이미 이 번호를 등록했으면 차단 (카카오 등 이메일 미제공 케이스 안전망)
    const { data: dupe } = await supabase
      .from('users').select('id').eq('phone', phone).neq('id', req.user.sub).limit(1);
    if (dupe && dupe.length) {
      return res.status(409).json({
        error: '이미 이 번호로 가입된 계정이 있습니다. 기존 로그인 방식(구글/네이버/카카오/이메일)으로 이용해주세요.',
        code: 'PHONE_TAKEN'
      });
    }

    const { data: user, error } = await supabase
      .from('users')
      .update({ phone, updated_at: new Date().toISOString() })
      .eq('id', req.user.sub)
      .select('id, email, name, phone, grade, point, is_admin')
      .single();

    if (error) throw error;
    res.json({ ok: true, user });
  } catch (err) {
    console.error('[phone]', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// ════════════════════════════════════════════
// GET /api/auth/me — 내 정보 조회
// ════════════════════════════════════════════
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('id, email, name, phone, grade, point, is_admin, marketing_agree, push_agree, created_at')
      .eq('id', req.user.sub)
      .single();

    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다' });
    res.json({ ok: true, user });
  } catch (err) {
    console.error('[me]', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

module.exports = router;
