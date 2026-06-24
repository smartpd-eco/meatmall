# 정육본가 D2C 쇼핑몰 — Claude Code 프로젝트 컨텍스트

## 프로젝트 개요
- **쇼핑몰명**: 정육본가 (Jeong Yuk Bonga)
- **콘셉트**: 돈육 전문 VVIP 프리미엄 D2C
- **디자인**: 블랙(70%) + 골드(30%) 테마
- **로고**: /meatmall/images/logo.png

## 배포 인프라
- **프론트**: GitHub Pages → `https://smartpd-eco.github.io/meatmall/`
- **API 서버**: Vercel → `https://meatmall.vercel.app/api`
- **DB**: Supabase PostgreSQL
- **레포**: `https://github.com/smartpd-eco/meatmall`

## 폴더 구조
```
meatmall/
├── index.html          ← 홈 (다크테마, 돈육 6종)
├── login.html          ← 로그인
├── images/
│   └── logo.png        ← 정육본가 로고 (모든 페이지 공통)
├── css/
│   └── main.css        ← 전체 디자인 시스템 (v4)
├── js/
│   └── app.js          ← Store, toast, showAdminBtn, BFCache방지
├── pages/
│   ├── mypage.html     ← 마이페이지 (흰배경+골드테두리)
│   ├── orders.html     ← 주문내역 (흰배경+골드테두리)
│   ├── cart.html       ← 장바구니+결제
│   ├── product.html    ← 상품상세
│   ├── category.html   ← 카테고리 (돈육 6종)
│   ├── address.html    ← 배송지관리
│   ├── signup.html     ← 회원가입
│   ├── order-complete.html
│   ├── subscribe.html  ← 정기배송
│   └── cs.html         ← 고객센터
└── admin/
    ├── dashboard.html  ← 관리자 대시보드
    ├── products.html   ← 상품 등록/관리
    └── payment-settings.html

meatmall-server/        ← Vercel API (Node.js Express)
├── server.js
└── api/
    ├── auth/           ← 이메일+소셜 로그인
    ├── products/       ← 상품 CRUD
    ├── payment/        ← 결제 (나이스페이먼츠)
    ├── admin/          ← 관리자 API
    └── notify/         ← 카카오 알림톡
```

## 핵심 디자인 규칙
- 블랙: `#0F0F0F`, `#1C1C1C`, `#262626`
- 골드: `#C9A84C` (주), `#E8C97A` (밝은), `#A8862A` (어두운)
- 헤더: 항상 `border-bottom: 2px solid #C9A84C`
- 네비: 항상 `border-top: 2px solid #C9A84C`
- 카드: `border: 1.5px solid rgba(201,168,76,.3)`
- 버튼: `background: linear-gradient(135deg, #A8862A, #E8C97A)`
- 로고: `<img src="[경로]/images/logo.png" height="34px">`

## 카테고리 (돈육 6종)
samgyeop(삼겹살), ogyeop(오겹살), moksal(목살),
apdaree(앞다리살), mibakapdaree(미박앞다리살), deungshim(등심)

## 레이아웃 규칙
- app-wrap: `max-width:430px`, `display:flex`, `flex-direction:column`, `min-height:100vh`
- 헤더: `position:sticky`, `top:0`, `z-index:100`
- 네비: `position:sticky`, `bottom:0`, `margin-top:auto`
- fixed 절대 사용 금지 (컨테이너 이탈 문제)

## 관리자 계정
- 이메일: admin@meatmall.co.kr
- 비밀번호: admin1234

## API 환경변수 (Vercel)
- NICE_CLIENT_KEY, NICE_SECRET_KEY (결제)
- KAKAO_CLIENT_ID, NAVER_CLIENT_ID, GOOGLE_CLIENT_ID (소셜로그인)
- VBANK_BANK=기업은행, VBANK_ACCOUNT=123-456789-01-001
- SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

## 작업 원칙
1. 수정 전 반드시 해당 파일 전체 읽기
2. 수정 후 반드시 결과 확인
3. git push 전 린트/문법 체크
4. 페이지별 독립 CSS — main.css 건드릴 때 특히 주의
