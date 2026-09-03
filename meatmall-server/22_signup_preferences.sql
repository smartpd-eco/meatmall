-- 자체 회원가입 선택 동의 저장용 운영 DB 보강
-- Supabase SQL Editor에서 한 번만 실행해도 안전합니다.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS marketing_agree BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS push_agree BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN users.marketing_agree IS '광고성 정보 수신 동의 여부';
COMMENT ON COLUMN users.push_agree IS '푸시 알림 수신 동의 여부';
