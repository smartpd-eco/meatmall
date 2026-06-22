require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — 모든 github.io 서브도메인 + 로컬 허용
const allowedOrigins = [
  'https://smartpd-eco.github.io',
  'https://smartpd-eco.github.io/',
  'http://localhost:5500',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000',
];

app.use(cors({
  origin: function(origin, callback) {
    // origin 없는 요청 (같은 서버, Postman 등) 허용
    if (!origin) return callback(null, true);
    // 허용 목록 체크
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // github.io 전체 허용 (서브도메인 포함)
    if (origin.endsWith('.github.io')) return callback(null, true);
    // vercel.app 내부 허용
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    // 그 외 차단
    callback(new Error('CORS 차단: ' + origin));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
}));
app.options('*', cors());

// Rate Limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: '너무 많은 시도입니다. 15분 후 다시 시도해주세요' },
  standardHeaders: true, legacyHeaders: false
});
app.use('/api/auth/login',  authLimiter);
app.use('/api/auth/signup', authLimiter);

// ── 라우터 ────────────────────────────────────────────
app.use('/api/auth',     require('./api/auth/email'));
app.use('/api/auth',     require('./api/auth/social'));
app.use('/api/products', require('./api/products/index'));
app.use('/api/payment',  require('./api/payment/index'));
app.use('/api/admin',    require('./api/admin/index'));
app.use('/api/notify',   require('./api/notify/index'));

// 헬스체크
app.get('/api/health', (req, res) => {
  res.json({
    ok: true, service: '정육본가 API', version: '2.1',
    time: new Date().toISOString(),
    endpoints: ['/auth','/products','/payment','/admin','/notify']
  });
});

app.use((req, res) => {
  res.status(404).json({ error: `${req.method} ${req.path} 를 찾을 수 없습니다` });
});
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다' });
});

app.listen(PORT, () => {
  console.log(`\n🥩 정육본가 API v2.1 — http://localhost:${PORT}\n`);
});
module.exports = app;
