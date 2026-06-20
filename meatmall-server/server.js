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

// CORS — GitHub Pages + 로컬 전부 허용
app.use(cors({
  origin: [
    'https://smartpd-eco.github.io',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:3001',
    'http://localhost:3000',
    process.env.FRONTEND_URL || '*'
  ],
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS']
}));
app.options('*', cors());

// Rate Limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: '너무 많은 시도입니다. 15분 후 다시 시도해주세요' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/auth/login',  authLimiter);
app.use('/api/auth/signup', authLimiter);

// 라우터
app.use('/api/auth', require('./api/auth/email'));
app.use('/api/auth', require('./api/auth/social'));

// 헬스체크
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: '정육본가 API', time: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: `${req.method} ${req.path} 를 찾을 수 없습니다` });
});

// 에러
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다' });
});

app.listen(PORT, () => {
  console.log(`\n🥩 정육본가 API 서버 시작`);
  console.log(`   http://localhost:${PORT}\n`);
});

module.exports = app;
