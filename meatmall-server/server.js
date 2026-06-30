require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

// ====================================================
// 인메모리 캐시 유틸리티 (TTL 기반)
// ====================================================
const _srvCache = new Map();
function getCache(key) {
  const e = _srvCache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { _srvCache.delete(key); return null; }
  return e.data;
}
function setCache(key, data, ttl = 60000) {
  _srvCache.set(key, { data, exp: Date.now() + ttl });
}
function clearCache(key) {
  if (key) _srvCache.delete(key); else _srvCache.clear();
}

const app = express();
app.set('trust proxy', 1); // Vercel/nginx 프록시 뒤 X-Forwarded-For 신뢰
const PORT = process.env.PORT || 3000;

// ====================================================
// CORS 설정
// GitHub Pages → Vercel API 호출 허용
// ====================================================

const allowedOrigins = [
  'https://smartpd-eco.github.io',
  'https://meatmall.vercel.app',
  'http://localhost:5500',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000'
];

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (origin.endsWith('.github.io')) return true;
  if (origin.endsWith('.vercel.app')) return true;
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Cookie');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.use(cors({
  origin: function(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    return callback(new Error('CORS 차단: ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie']
}));

// ====================================================
// 기본 미들웨어
// request entity too large 방지
// ====================================================

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false
}));

app.use(cookieParser());

app.use(express.json({
  limit: '50mb'
}));

app.use(express.urlencoded({
  extended: true,
  limit: '50mb'
}));

// ====================================================
// Rate Limiting
// ====================================================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    error: '너무 많은 시도입니다. 15분 후 다시 시도해주세요'
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);

// ====================================================
// 라우터
// ====================================================

app.use('/api/auth', require('./api/auth/email'));
app.use('/api/auth', require('./api/auth/social'));
app.use('/api/products',   require('./api/products/index'));
app.use('/api/addresses',  require('./api/addresses/index'));
app.use('/api/payment', require('./api/payment/index'));
app.use('/api/admin/categories', require('./api/admin/categories'));
app.use('/api/admin/vendors', require('./api/admin/vendors'));
app.use('/api/admin/assignments', require('./api/admin/assignments'));
app.use('/api/admin/vendor-inventory', require('./api/admin/vendor-inventory'));
app.use('/api/admin', require('./api/admin/index'));
app.use('/api/notify', require('./api/notify/index'));
app.use('/api/upload', require('./api/upload/index'));
app.use('/api/crm/segments',     require('./api/crm/segments'));
app.use('/api/crm/insights',     require('./api/crm/insights'));
app.use('/api/crm/churn',        require('./api/crm/churn'));
app.use('/api/crm/templates',    require('./api/crm/templates'));
app.use('/api/crm/campaigns',    require('./api/crm/campaigns'));
app.use('/api/crm/send-logs',    require('./api/crm/send-logs'));
app.use('/api/crm/inventory-ai', require('./api/crm/inventory-ai'));
app.use('/api/crm/coupon-rules', require('./api/crm/coupon-rules'));

// ====================================================
// 헬스체크
// ====================================================

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: '정육본가 API',
    version: '3.0',
    time: new Date().toISOString(),
    endpoints: ['/auth', '/products', '/payment', '/admin', '/notify']
  });
});

// ====================================================
// 404
// ====================================================

app.use((req, res) => {
  res.status(404).json({
    error: `${req.method} ${req.path} 를 찾을 수 없습니다`
  });
});

// ====================================================
// 전역 에러 핸들러
// ====================================================

app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);

  const statusCode = err.message && err.message.startsWith('CORS 차단')
    ? 403
    : 500;

  res.status(statusCode).json({
    error: err.message || '서버 내부 오류가 발생했습니다'
  });
});

app.listen(PORT, () => {
  console.log(`\n🥩 정육본가 API v2.3 — http://localhost:${PORT}\n`);
});

module.exports = app;
module.exports.getCache = getCache;
module.exports.setCache = setCache;
module.exports.clearCache = clearCache;

// redeploy trigger 2026-06-28T19:20:01Z
