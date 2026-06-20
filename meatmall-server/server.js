require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit   = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 보안 미들웨어
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS (프론트엔드 허용)
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://localhost:3001'
  ],
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS']
}));

// ── Rate Limiting (로그인 브루트포스 방지)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15분
  max: 20,                    // 최대 20회
  message: { error: '너무 많은 시도입니다. 15분 후 다시 시도해주세요' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/auth/login',  authLimiter);
app.use('/api/auth/signup', authLimiter);

// ── 정적 파일 (프론트엔드 빌드 서빙 - 옵션)
// app.use(express.static('public'));

// ════════════════════════════════════════════
// 라우터 등록
// ════════════════════════════════════════════
app.use('/api/auth',          require('./api/auth/email'));
app.use('/api/auth',          require('./api/auth/social'));

// 상태 확인 엔드포인트
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: '정육본가 API', time: new Date().toISOString() });
});

// 404 핸들러
app.use((req, res) => {
  res.status(404).json({ error: `${req.method} ${req.path} 엔드포인트를 찾을 수 없습니다` });
});

// 글로벌 에러 핸들러
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다' });
});

app.listen(PORT, () => {
  console.log(`\n🥩 정육본가 API 서버 시작`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   환경: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
