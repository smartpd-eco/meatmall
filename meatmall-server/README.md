# 🥩 정육본가 D2C 쇼핑몰

육가공 전문 D2C 커머스 플랫폼 — 직접가공 + OEM PB + 거래처 유통 3채널

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 | Vanilla HTML/CSS/JS (모바일 퍼스트) |
| 백엔드 API | Node.js + Express |
| 데이터베이스 | Supabase (PostgreSQL) |
| 인증 | JWT + 카카오/네이버/구글 OAuth |
| 배포 | Vercel (서버리스) |
| CI/CD | GitHub Actions |

## 프로젝트 구조

```
meatmall/           ← 프론트엔드
├── index.html      메인 홈
├── login.html      로그인
├── css/main.css    공통 디자인
├── js/app.js       공통 유틸
├── js/api.js       API 클라이언트
├── pages/          상세 페이지들
└── admin/          관리자 대시보드

meatmall-server/    ← 백엔드 API
├── server.js       Express 진입점
├── api/auth/       인증 라우터
├── lib/            유틸 (supabase, jwt)
├── middleware/     인증 미들웨어
└── supabase-schema.sql  DB 스키마
```

## 로컬 개발 실행

```bash
# 1. 환경변수 설정
cd meatmall-server
cp .env.example .env
# .env 파일에 실제 키 입력

# 2. 백엔드 실행
npm install
npm run dev        # http://localhost:3000

# 3. 프론트엔드 실행 (별도 터미널)
cd ../meatmall
npx serve . -p 5500   # http://localhost:5500
```

## 배포

main 브랜치에 push 하면 GitHub Actions → Vercel 자동 배포됩니다.

```bash
git add .
git commit -m "feat: 기능 설명"
git push origin main
# → 자동으로 Vercel 배포 시작
```

## 주요 API

```
POST /api/auth/signup        이메일 회원가입
POST /api/auth/login         이메일 로그인
POST /api/auth/logout        로그아웃
POST /api/auth/refresh       토큰 갱신
GET  /api/auth/me            내 정보
GET  /api/auth/kakao         카카오 로그인
GET  /api/auth/naver         네이버 로그인
GET  /api/auth/google        구글 로그인
GET  /api/health             서버 상태
```

## 환경변수 목록

`.env.example` 참고 — Vercel 대시보드 → Settings → Environment Variables에도 동일하게 입력 필요
