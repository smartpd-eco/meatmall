# MeatMall 배송지 SMS 인증번호 운영 설정

## 결론

새 SOLAPI 시크릿 키를 재발급하지 않는다.

현재 알림톡에서 이미 사용하는 SOLAPI 공통 키를 SMS 인증번호 발송에도 그대로 같이 사용한다.

## Vercel 환경변수 작성 기준

Vercel에서 이미 등록된 기존 키를 그대로 사용한다.

```text
SOLAPI_API_KEY=기존 알림톡에서 사용 중인 SOLAPI API Key
SOLAPI_API_SECRET=기존 알림톡에서 사용 중인 SOLAPI API Secret
ALIMTALK_SENDER_NO=기존 알림톡 발신번호
```

SMS 인증 전용으로 새로 추가하면 좋은 값은 아래 1개뿐이다.

```text
SOLAPI_SENDER=SMS 발신번호
```

단, `SOLAPI_SENDER`가 없으면 서버는 기존 `ALIMTALK_SENDER_NO`를 자동으로 재사용한다.

## 키를 가져오는 위치

- SOLAPI API Key / Secret: https://console.solapi.com/developer/api-keys
- SOLAPI 발신번호: https://console.solapi.com/sender-numbers

## 중요한 주의사항

`SOLAPI_API_SECRET`을 재발급하면 기존 알림톡 발송도 같이 영향을 받을 수 있다.

따라서 SMS 인증 때문에 별도 재발급하지 말고, 현재 Vercel에 등록된 기존 `SOLAPI_API_KEY`, `SOLAPI_API_SECRET`을 그대로 유지한다.

새 키를 반드시 재발급해야 하는 경우에는 아래 둘을 동시에 확인해야 한다.

```text
1. 알림톡 발송 정상 여부
2. SMS 인증번호 발송 정상 여부
```

## 동작 흐름

1. 사용자가 배송지 화면에서 휴대폰 번호 입력
2. 인증번호 버튼 클릭
3. 서버가 6자리 인증번호 생성
4. 기존 SOLAPI 공통 키로 SMS 발송
5. 사용자가 3분 안에 인증번호 입력
6. 서버가 인증번호 확인 후 10분짜리 `phoneVerifyToken` 발급
7. 배송지 저장/수정 API가 토큰과 전화번호 일치를 검증

## 보안 정책

- 인증번호 유효시간: 3분
- 재발송 제한: 1분
- 입력 실패 제한: 5회
- 신규 배송지 등록: 휴대폰 인증 필수
- 기존 배송지 수정: 전화번호 변경 시에만 재인증 필수
