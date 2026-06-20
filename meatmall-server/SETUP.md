# 정육본가 D2C 쇼핑몰 — 실제 로그인 연동 셋업 가이드

## 전체 구조
```
프론트엔드 (meatmall/)  ←→  백엔드 API (meatmall-server/)  ←→  Supabase DB
```

---

## STEP 1. Supabase 프로젝트 생성 (5분)

1. https://supabase.com 접속 → 회원가입
2. **New Project** 클릭
   - 프로젝트 이름: `meatmall`
   - DB 비밀번호: 기억해 둘 것
   - Region: **Northeast Asia (Seoul)**
3. 생성 완료 후 **Settings → API** 에서 아래 값 복사:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` 키 → `SUPABASE_ANON_KEY`
   - `service_role` 키 → `SUPABASE_SERVICE_ROLE_KEY`
4. **SQL Editor** 탭 → `supabase-schema.sql` 내용 전체 붙여넣기 → **Run**

---

## STEP 2. 카카오 OAuth 설정 (10분)

1. https://developers.kakao.com → **내 애플리케이션 → 애플리케이션 추가**
   - 앱 이름: `정육본가`
2. **앱 키** 탭에서 `REST API 키` 복사 → `KAKAO_CLIENT_ID`
3. **카카오 로그인** 탭:
   - 활성화 ON
   - **Redirect URI 추가**: `http://localhost:3000/api/auth/kakao/callback`
   - 배포 시: `https://your-domain.vercel.app/api/auth/kakao/callback`
4. **보안** 탭 → Client Secret 코드 발급 → `KAKAO_CLIENT_SECRET`
5. **동의항목** → 닉네임, 카카오계정(이메일) 체크

---

## STEP 3. 네이버 OAuth 설정 (10분)

1. https://developers.naver.com → **Application → 애플리케이션 등록**
   - 사용 API: **네아로(네이버 아이디로 로그인)**
   - 서비스 URL: `http://localhost:3000`
   - Callback URL: `http://localhost:3000/api/auth/naver/callback`
2. **애플리케이션 정보**에서:
   - `Client ID` → `NAVER_CLIENT_ID`
   - `Client Secret` → `NAVER_CLIENT_SECRET`

---

## STEP 4. 구글 OAuth 설정 (10분)

1. https://console.cloud.google.com → 프로젝트 생성
2. **API 및 서비스 → 사용자 인증정보 → OAuth 2.0 클라이언트 ID 만들기**
   - 유형: 웹 애플리케이션
   - 승인된 리디렉션 URI: `http://localhost:3000/api/auth/google/callback`
3. 생성 후 `클라이언트 ID` → `GOOGLE_CLIENT_ID`, `클라이언트 보안 비밀` → `GOOGLE_CLIENT_SECRET`
4. **OAuth 동의 화면** → 테스트 사용자에 본인 이메일 추가

---

## STEP 5. 환경변수 설정

```bash
cd meatmall-server
cp .env.example .env
# .env 파일 열어서 위에서 복사한 값들 입력
```

---

## STEP 6. 백엔드 서버 실행

```bash
cd meatmall-server
npm install
npm run dev
# → http://localhost:3000 에서 API 서버 실행
```

서버 확인:
```bash
curl http://localhost:3000/api/health
# {"ok":true,"service":"정육본가 API",...}
```

---

## STEP 7. 프론트엔드 실행

VS Code 기준:
1. `meatmall/` 폴더를 VS Code 에서 열기
2. **Live Server** 확장 설치 (없으면)
3. `login.html` 에서 우클릭 → **Open with Live Server**
4. → `http://localhost:5500/login.html` 에서 실행

또는 간단히:
```bash
cd meatmall
npx serve . -p 5500
```

---

## STEP 8. 테스트

1. `http://localhost:5500/login.html` 접속
2. **카카오로 시작하기** 클릭 → 카카오 로그인 → 홈 이동
3. **이메일 회원가입** → 정보 입력 → 완료
4. 이메일로 로그인 → 홈 이동

---

## Vercel 배포 (무료)

```bash
npm install -g vercel
cd meatmall-server
vercel

# 환경변수는 Vercel 대시보드 → Settings → Environment Variables 에 입력
# 배포 후 카카오/네이버/구글 개발자 콘솔에서 Redirect URI를
# https://your-project.vercel.app/api/auth/카카오|naver|google/callback 으로 추가
```

---

## API 엔드포인트 목록

| Method | URL | 설명 |
|--------|-----|------|
| POST | /api/auth/signup | 이메일 회원가입 |
| POST | /api/auth/login | 이메일 로그인 |
| POST | /api/auth/logout | 로그아웃 |
| POST | /api/auth/refresh | 토큰 갱신 |
| GET  | /api/auth/me | 내 정보 조회 |
| GET  | /api/auth/kakao | 카카오 로그인 시작 |
| GET  | /api/auth/kakao/callback | 카카오 콜백 |
| GET  | /api/auth/naver | 네이버 로그인 시작 |
| GET  | /api/auth/naver/callback | 네이버 콜백 |
| GET  | /api/auth/google | 구글 로그인 시작 |
| GET  | /api/auth/google/callback | 구글 콜백 |
| GET  | /api/health | 서버 상태 확인 |
