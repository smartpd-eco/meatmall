-- ════════════════════════════════════════════════════
-- orders 테이블 무통장 컬럼 추가
-- Supabase SQL Editor에서 실행
-- ════════════════════════════════════════════════════

-- 무통장 관련 컬럼 추가
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS bank_name       VARCHAR(50),
  ADD COLUMN IF NOT EXISTS depositor_name  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS deposit_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS partial_cancel_amount INTEGER DEFAULT 0;

-- payment_status에 awaiting_deposit 허용 (기존 VARCHAR라 별도 처리 불필요)
-- status에 pending_deposit 허용 (기존 VARCHAR라 별도 처리 불필요)

SELECT 'orders 테이블 무통장 컬럼 추가 완료' AS result;
