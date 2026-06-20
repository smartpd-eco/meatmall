const jwt  = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('./supabase');

const SECRET  = process.env.JWT_SECRET;
const EXPIRES = process.env.JWT_EXPIRES_IN || '7d';
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

// ── Access Token 발급 (단기, 7일)
function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, grade: user.grade, is_admin: user.is_admin },
    SECRET,
    { expiresIn: EXPIRES }
  );
}

// ── Refresh Token 발급 (장기, 30일) → DB 저장
async function signRefreshToken(userId) {
  const token = uuidv4() + '-' + uuidv4(); // 64자 고유 토큰
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await supabase.from('refresh_tokens').insert({
    user_id: userId, token, expires_at: expiresAt.toISOString()
  });

  return { token, expiresAt };
}

// ── Access Token 검증
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

// ── Refresh Token 검증 → 새 Access Token 발급
async function rotateRefreshToken(refreshToken) {
  // DB에서 토큰 조회
  const { data: stored } = await supabase
    .from('refresh_tokens')
    .select('*, users(*)')
    .eq('token', refreshToken)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (!stored) return null;

  // 기존 토큰 삭제 (1회용)
  await supabase.from('refresh_tokens').delete().eq('token', refreshToken);

  const user = stored.users;
  const accessToken  = signAccessToken(user);
  const { token: newRefresh, expiresAt } = await signRefreshToken(user.id);

  return { accessToken, refreshToken: newRefresh, expiresAt, user };
}

// ── 모든 Refresh Token 삭제 (로그아웃)
async function revokeAllTokens(userId) {
  await supabase.from('refresh_tokens').delete().eq('user_id', userId);
}

module.exports = { signAccessToken, signRefreshToken, verifyAccessToken, rotateRefreshToken, revokeAllTokens };
