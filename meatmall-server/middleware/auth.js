const { verifyAccessToken } = require('../lib/jwt');

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

// ── 관리자 전용 미들웨어
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) {
      return res.status(403).json({ error: '관리자 권한이 필요합니다' });
    }
    next();
  });
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

module.exports = { requireAuth, requireAdmin, optionalAuth };
