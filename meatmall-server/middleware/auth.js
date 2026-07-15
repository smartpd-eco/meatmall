const { verifyAccessToken } = require('../lib/jwt');
const supabase = require('../lib/supabase');

// ── 인증 필수 미들웨어
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }

  const token = header.split(' ')[1];
  const payload = verifyAccessToken(token);

  if (!payload) {
    return res.status(401).json({ error: '토큰이 만료되었거나 유효하지 않습니다' });
  }

  req.user = payload;
  next();
}

// ── 관리자 전용 미들웨어 (JWT 검증 + DB is_admin 재확인)
async function requireAdmin(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }
  const token = header.split(' ')[1];
  const payload = verifyAccessToken(token);
  if (!payload) {
    return res.status(401).json({ error: '토큰이 만료되었거나 유효하지 않습니다' });
  }
  try {
    const { data: user } = await supabase
      .from('users')
      .select('is_admin')
      .eq('id', payload.sub)
      .single();
    if (!user || !user.is_admin) {
      return res.status(403).json({ error: '관리자 권한이 필요합니다' });
    }
    req.user = payload;
    next();
  } catch (err) {
    console.error('[requireAdmin]', err);
    return res.status(500).json({ error: '권한 확인 오류' });
  }
}

// ── 벤더 전용 미들웨어 (JWT 검증 + DB vendor_id 재확인)
async function requireVendor(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }
  const token = header.split(' ')[1];
  const payload = verifyAccessToken(token);
  if (!payload) {
    return res.status(401).json({ error: '토큰이 만료되었거나 유효하지 않습니다' });
  }
  try {
    const { data: user } = await supabase
      .from('users')
      .select('vendor_id, role, is_active')
      .eq('id', payload.sub)
      .single();
    if (!user || !user.vendor_id) {
      return res.status(403).json({ error: '벤더 권한이 필요합니다' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: '비활성화된 계정입니다' });
    }
    req.user = payload;
    req.vendorId = user.vendor_id;
    next();
  } catch (err) {
    console.error('[requireVendor]', err);
    return res.status(500).json({ error: '권한 확인 오류' });
  }
}

// ── 선택적 인증 (로그인 안 해도 OK, 했으면 user 주입)
function optionalAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) {
    const payload = verifyAccessToken(header.split(' ')[1]);
    if (payload) req.user = payload;
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireVendor, optionalAuth };
