-- 회원가입 기본 배송지 저장 호환성 보강
-- Supabase SQL Editor에서 한 번만 실행해도 안전합니다.

ALTER TABLE public.addresses
  ADD COLUMN IF NOT EXISTS label VARCHAR(50),
  ADD COLUMN IF NOT EXISTS address2 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_addresses_user_default
  ON public.addresses(user_id, is_default);
