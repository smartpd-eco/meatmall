-- ════════════════════════════════════════════════════════════
-- 08_vendor_portal.sql
-- 벤더사(정육점) 전용 포털 : 회원계정 벤더권한 + 상품 당일배송 플래그
-- ════════════════════════════════════════════════════════════

-- ── 1. users : 벤더 권한 연결 ──────────────────────────────
--  role : 'customer'(기본) | 'vendor' | 'admin'(참고, 실제 관리자 판단은 is_admin 유지)
--  vendor_id : 연결된 vendors.id (NULL = 일반 회원)
ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_id BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role      VARCHAR(20) NOT NULL DEFAULT 'customer';
CREATE INDEX IF NOT EXISTS idx_users_vendor ON users(vendor_id);

-- ── 2. products : 벤더 소유 + 당일배송 ─────────────────────
--  vendor_id     : 등록 주체 벤더 (NULL = 본사 상품)
--  is_same_day   : 당일배송 대상 상품 여부
--  same_day_qty  : 당일배송 가능수량 (일 한도)
ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_id    BIGINT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_same_day  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS same_day_qty INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_products_vendor  ON products(vendor_id);
CREATE INDEX IF NOT EXISTS idx_products_sameday ON products(is_same_day) WHERE is_same_day = true;

-- ── 3. vendor_orders : 발주현황 상태/납품요청일 보강 ──────
--  (테이블은 기존 자동배정 로직에서 생성됨. 없는 컬럼만 안전하게 추가)
ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS delivery_date DATE;
ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS note          TEXT;
ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ── 4. 벤더 계정 연결 방법 안내 ────────────────────────────
--   이 SQL(컬럼 추가)만 실행하면 됩니다. 실제 "회원계정 ↔ 거래처" 연결은
--   수동 SQL이 아니라 관리자 페이지에서 처리합니다:
--     관리자 대시보드 → 거래처관리 → 해당 거래처 [계정] 버튼
--       → 회원 이메일 입력 후 [연결]  (users.vendor_id·role 자동 세팅)
--       → [연결해제]로 권한 회수
--   (백엔드 API: POST /api/admin/vendors/:id/link-account · unlink-account)
--
--   ※ 아래는 비상시 참고용 수동 쿼리(평소엔 사용하지 마세요):
--   -- UPDATE users SET role='vendor', vendor_id=1 WHERE email='vendor001@example.com';
