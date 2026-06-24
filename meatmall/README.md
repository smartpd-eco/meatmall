# 🥩 정육본가 D2C 쇼핑몰

돈육 전문 VVIP 프리미엄 D2C 플랫폼

## 🚀 로컬 개발 환경 세팅

### 1단계 — 레포 클론
```bash
cd C:\
git clone https://github.com/smartpd-eco/meatmall.git
cd meatmall
```

### 2단계 — VS Code 열기
```bash
code .
```

### 3단계 — Live Server로 프론트 실행
1. VS Code 확장 `Live Server` 설치
2. `meatmall/index.html` 우클릭 → **Open with Live Server**
3. 브라우저에서 `http://127.0.0.1:5500/meatmall/index.html` 확인

### 4단계 — API 서버 로컬 실행 (선택)
```bash
cd meatmall-server
cp .env.example .env
# .env 파일에 실제 키값 입력
npm install
npm start
```

### 5단계 — Claude Code로 바이브코딩
```bash
cd C:\meatmall
claude
```

## 📦 배포

```bash
git add -A
git commit -m "수정 내용"
git push origin main
```
- **프론트**: GitHub Pages 자동 배포 (1~2분)
- **API**: Vercel 자동 배포 (1~2분)

## 🗂 프로젝트 구조

```
meatmall/          ← 프론트엔드 (GitHub Pages)
├── index.html     ← 홈
├── images/logo.png
├── css/main.css
├── js/app.js
├── pages/         ← 고객 페이지 (12개)
├── admin/         ← 관리자 페이지 (3개)
└── CLAUDE.md      ← Claude Code 프로젝트 컨텍스트

meatmall-server/   ← API 서버 (Vercel)
├── server.js
├── api/
└── .env.example
```

## 🎨 디자인 시스템
- **테마**: 블랙 70% + 골드 30%
- **골드**: `#C9A84C`
- **최대 너비**: 430px (모바일 기준)

## 🔑 관리자
- URL: `/meatmall/admin/dashboard.html`
- 이메일: `admin@meatmall.co.kr`
- 비밀번호: `admin1234`

## 🌐 URL
- 쇼핑몰: https://smartpd-eco.github.io/meatmall/
- API: https://meatmall.vercel.app/api
- DB: https://supabase.com/dashboard/project/bwaxzudkmuffvzaalqeo
