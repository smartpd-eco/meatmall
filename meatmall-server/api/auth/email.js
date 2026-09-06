const express  = require('express');
const bcrypt   = require('bcryptjs');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { signAccessToken, signRefreshToken, rotateRefreshToken, revokeAllTokens, signPhoneVerifyToken } = require('../../lib/jwt');
const { requireAuth } = require('../../middleware/auth');
const { sendSms, normalizePhone } = require('../../lib/solapi');

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
    const { password, marketing_agree, push_agree } = req.body;
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim();
    const zip_code = String(req.body.zip_code || '').trim();
    const address1 = String(req.body.address1 || '').trim();
    const address2 = String(req.body.address2 || '').trim();

    // 입력 검증
    if (!name || !email || !password)
      return res.status(400).json({ error: '이름, 이메일, 비밀번호는 필수입니다' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: '올바른 이메일 형식이 아닙니다' });
    if (password.length < 8)
      return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });
    const hasAddress = !!(zip_code || address1 || address2);
    if (hasAddress && (!phone || !zip_code || !address1))
      return res.status(400).json({ error: '휴대폰, 우편번호, 기본 주소를 모두 입력해주세요' });

    // 중복 이메일 확인
    const { data: existingRows, error: existingError } = await supabase
      .from('users').select('id').ilike('email', email).limit(1);
    if (existingError) throw existingError;
    const existing = existingRows?.[0];
    if (existing)
      return res.status(409).json({ error: '이미 사용 중인 이메일입니다' });

    // 비밀번호 해싱
    const password_hash = await bcrypt.hash(password, 12);

    // 사용자 생성
    const { data: user, error } = await supabase
      .from('users')
      .insert({ name, email, password_hash, phone: phone || null })
      .select('id, email, name, grade, point, is_admin')
      .single();

    if (error) throw error;

    // 운영 DB가 구버전이어도 가입을 막지 않는다. 22_signup_preferences.sql 적용 후 정상 기록된다.
    const { error: preferenceError } = await supabase.from('users').update({
      marketing_agree: !!marketing_agree,
      push_agree: !!push_agree,
    }).eq('id', user.id);
    if (preferenceError) console.warn('[signup/preferences]', preferenceError.message);

    // 신규 가입 화면에서 입력한 주소는 회원의 기본 배송지로 즉시 연결한다.
    // 주소 입력이 없는 구버전/캐시된 가입 화면 요청도 기존처럼 허용한다.
    let addressSaved = !hasAddress;
    if (hasAddress) {
      // 운영 DB별 선택 컬럼 차이를 피하기 위해 공통 핵심 컬럼부터 저장한다.
      const { data: savedAddress, error: addressError } = await supabase.from('addresses').insert({
        user_id: user.id,
        recipient: name,
        phone,
        zip_code,
        address1,
      }).select('id').single();
      if (addressError) {
        // 배송지 스키마 문제 때문에 생성된 회원까지 취소하지 않는다.
        console.error('[signup/address]', addressError);
      } else {
        addressSaved = true;
        // 구버전 DB에 선택 컬럼이 없어도 핵심 배송지 저장은 유지한다.
        const { error: defaultError } = await supabase.from('addresses')
          .update({ label: '집', address2: address2 || '', is_default: true })
          .eq('id', savedAddress.id);
        if (defaultError) console.warn('[signup/address-default]', defaultError.message);
      }
    }

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

    res.status(201).json({
      ok: true,
      user: { id: user.id, name: user.name, email: user.email, grade: user.grade, point: user.point },
      accessToken,
      addressSaved,
      needsAddress: hasAddress && !addressSaved,
    });
  } catch (err) {
    console.error('[signup]', err);
    if (err?.code === '23505')
      return res.status(409).json({ error: '이미 사용 중인 이메일입니다' });
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// ════════════════════════════════════════════
// POST /api/auth/login — 이메일 로그인
// ════════════════════════════════════════════
router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요' });

    // 사용자 조회
    const { data: user } = await supabase
      .from('users')
      .select('id, email, name, password_hash, grade, point, is_admin, is_active, vendor_id, role')
      .ilike('email', email)
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
const smsCodes = new Map();

function makeSmsKey(userId, phone) {
  return `${userId}:${normalizePhone(phone)}`;
}

function makeSmsCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function cleanupSmsCodes() {
  const now = Date.now();
  for (const [key, row] of smsCodes.entries()) {
    if (!row || row.expiresAt <= now) smsCodes.delete(key);
  }
}

router.post('/sms/start', requireAuth, async (req, res) => {
  try {
    cleanupSmsCodes();
    const { phone } = req.body || {};
    if (!phone || !PHONE_RE.test(phone)) {
      return res.status(400).json({ ok: false, error: '휴대폰 번호 형식이 올바르지 않습니다 (010-0000-0000)' });
    }

    const key = makeSmsKey(req.user.sub, phone);
    const prev = smsCodes.get(key);
    if (prev && Date.now() - prev.sentAt < 60 * 1000) {
      return res.status(429).json({ ok: false, error: '인증번호는 1분 후 다시 발송할 수 있습니다' });
    }

    const code = makeSmsCode();
    const text = `[정육본가] 배송지 휴대폰 인증번호는 ${code}입니다. 3분 이내 입력해주세요.`;
    const sent = await sendSms({ phone, text });
    if (!sent.ok) {
      return res.status(502).json({ ok: false, error: sent.error || '인증번호 발송에 실패했습니다' });
    }
    if (sent.dev && process.env.NODE_ENV === 'production') {
      return res.status(503).json({ ok: false, error: 'SMS 발송 환경변수가 설정되지 않았습니다' });
    }

    smsCodes.set(key, {
      code,
      sentAt: Date.now(),
      expiresAt: Date.now() + 3 * 60 * 1000,
      attempts: 0,
    });

    res.json({
      ok: true,
      expiresIn: 180,
      dev: !!sent.dev,
      ...(sent.dev ? { devCode: code } : {}),
    });
  } catch (err) {
    console.error('[sms/start]', err);
    res.status(500).json({ ok: false, error: '인증번호 발송 중 오류가 발생했습니다' });
  }
});

router.post('/sms/confirm', requireAuth, async (req, res) => {
  try {
    cleanupSmsCodes();
    const { phone, code } = req.body || {};
    if (!phone || !PHONE_RE.test(phone)) {
      return res.status(400).json({ ok: false, error: '휴대폰 번호 형식이 올바르지 않습니다' });
    }
    if (!/^\d{6}$/.test(String(code || ''))) {
      return res.status(400).json({ ok: false, error: '인증번호 6자리를 입력해주세요' });
    }

    const key = makeSmsKey(req.user.sub, phone);
    const row = smsCodes.get(key);
    if (!row) {
      return res.status(400).json({ ok: false, error: '인증번호가 만료되었거나 발송 이력이 없습니다' });
    }
    if (row.expiresAt <= Date.now()) {
      smsCodes.delete(key);
      return res.status(400).json({ ok: false, error: '인증번호가 만료되었습니다. 다시 발송해주세요' });
    }
    if (row.attempts >= 5) {
      smsCodes.delete(key);
      return res.status(429).json({ ok: false, error: '인증 시도 횟수를 초과했습니다. 다시 발송해주세요' });
    }

    row.attempts += 1;
    if (row.code !== String(code)) {
      return res.status(400).json({ ok: false, error: '인증번호가 일치하지 않습니다' });
    }

    smsCodes.delete(key);
    const verifyToken = signPhoneVerifyToken({ userId: req.user.sub, phone });
    res.json({ ok: true, verifyToken });
  } catch (err) {
    console.error('[sms/confirm]', err);
    res.status(500).json({ ok: false, error: '인증번호 확인 중 오류가 발생했습니다' });
  }
});

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
      .select('id, email, name, phone, grade, point, is_admin, vendor_id, role, marketing_agree, push_agree, created_at')
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
