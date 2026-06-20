-- ════════════════════════════════════════════════════════════
-- 정육본가 D2C 쇼핑몰 — Supabase PostgreSQL 스키마
-- Supabase Dashboard → SQL Editor 에서 실행
-- ════════════════════════════════════════════════════════════

-- ── 확장 기능 활성화
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ════════════════════════════════════════════════════════════
-- 1. 회원 테이블
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           VARCHAR(255) UNIQUE,
  password_hash   VARCHAR(255),                     -- 이메일 로그인 시만 사용
  name            VARCHAR(100) NOT NULL DEFAULT '',
  phone           VARCHAR(20),
  grade           VARCHAR(20)  NOT NULL DEFAULT 'BASIC', -- BASIC / SILVER / GOLD / VIP
  point           INTEGER      NOT NULL DEFAULT 0,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  is_admin        BOOLEAN      NOT NULL DEFAULT false,
  marketing_agree BOOLEAN      NOT NULL DEFAULT false,
  push_agree      BOOLEAN      NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 소셜 계정 연결 테이블
CREATE TABLE IF NOT EXISTS social_accounts (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     VARCHAR(20) NOT NULL,   -- kakao | naver | google | apple
  provider_id  VARCHAR(255) NOT NULL,  -- 각 플랫폼의 고유 사용자 ID
  access_token TEXT,
  refresh_token TEXT,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, provider_id)
);

-- ── 리프레시 토큰 테이블
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 배송지 테이블
CREATE TABLE IF NOT EXISTS addresses (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        VARCHAR(50),   -- 집 | 회사 | 기타
  recipient    VARCHAR(100) NOT NULL,
  phone        VARCHAR(20) NOT NULL,
  zip_code     VARCHAR(10) NOT NULL,
  address1     VARCHAR(255) NOT NULL,
  address2     VARCHAR(255),
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════
-- 2. 상품 테이블
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS products (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  category      VARCHAR(50) NOT NULL,  -- beef | pork | chicken | processed | giftset | mealkit
  source_type   VARCHAR(20),           -- direct | oem | wholesale
  origin        VARCHAR(100),          -- 원산지
  weight_g      INTEGER,               -- 그램 단위
  price         INTEGER NOT NULL,
  origin_price  INTEGER,               -- 정가 (할인 전)
  stock         INTEGER NOT NULL DEFAULT 0,
  min_stock     INTEGER NOT NULL DEFAULT 10, -- 안전재고
  expiry_days   INTEGER,               -- 소비기한 (일)
  is_active     BOOLEAN NOT NULL DEFAULT true,
  is_subscribe  BOOLEAN NOT NULL DEFAULT false, -- 정기배송 가능
  haccp         BOOLEAN NOT NULL DEFAULT false,
  emoji         VARCHAR(10) DEFAULT '🥩',
  thumbnail_url TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════
-- 3. 주문 테이블
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number    VARCHAR(30) UNIQUE NOT NULL,  -- ORD-YYYYMMDD-XXXX
  user_id         UUID NOT NULL REFERENCES users(id),
  status          VARCHAR(30) NOT NULL DEFAULT 'pending',
  -- pending | preparing | shipping | delivered | cancelled | refund_req | refunded

  -- 배송 정보
  recipient       VARCHAR(100) NOT NULL,
  phone           VARCHAR(20) NOT NULL,
  zip_code        VARCHAR(10) NOT NULL,
  address1        VARCHAR(255) NOT NULL,
  address2        VARCHAR(255),
  delivery_note   TEXT,

  -- 금액
  product_total   INTEGER NOT NULL DEFAULT 0,
  delivery_fee    INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  point_used      INTEGER NOT NULL DEFAULT 0,
  final_amount    INTEGER NOT NULL DEFAULT 0,

  -- 결제
  payment_method  VARCHAR(30),  -- kakao | naver | toss | card | bank
  payment_status  VARCHAR(20) NOT NULL DEFAULT 'unpaid', -- unpaid | paid | failed | refunded
  payment_key     VARCHAR(255), -- PG사 거래 키
  paid_at         TIMESTAMPTZ,

  -- 배송
  tracking_number VARCHAR(100),
  carrier         VARCHAR(50),
  shipped_at      TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 주문 상품 상세
CREATE TABLE IF NOT EXISTS order_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  UUID REFERENCES products(id),
  name        VARCHAR(255) NOT NULL,  -- 주문 시점 상품명 스냅샷
  option      VARCHAR(100),
  price       INTEGER NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  subtotal    INTEGER NOT NULL
);

-- ════════════════════════════════════════════════════════════
-- 4. 정기배송 구독
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS subscriptions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id),
  status         VARCHAR(20) NOT NULL DEFAULT 'active', -- active | paused | cancelled
  cycle          VARCHAR(10) NOT NULL DEFAULT 'weekly', -- weekly | biweekly | monthly
  next_date      DATE NOT NULL,
  payment_method VARCHAR(30),
  billing_key    VARCHAR(255),   -- PG사 자동결제 키
  fail_count     INTEGER NOT NULL DEFAULT 0,
  paused_at      TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id),
  name            VARCHAR(255) NOT NULL,
  option          VARCHAR(100),
  price           INTEGER NOT NULL,
  qty             INTEGER NOT NULL DEFAULT 1
);

-- ════════════════════════════════════════════════════════════
-- 5. CS 문의
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cs_tickets (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id),
  order_id   UUID REFERENCES orders(id),
  type       VARCHAR(30) NOT NULL,   -- order | payment | product | subscribe | account | other
  title      VARCHAR(255) NOT NULL,
  content    TEXT NOT NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | in_progress | answered | closed
  answer     TEXT,
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════
-- 6. 쿠폰 & 포인트
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS coupons (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code          VARCHAR(50),
  name          VARCHAR(100) NOT NULL,
  type          VARCHAR(20) NOT NULL,  -- percent | fixed | free_delivery
  value         INTEGER NOT NULL,      -- 퍼센트 or 고정금액
  min_amount    INTEGER DEFAULT 0,
  expires_at    TIMESTAMPTZ,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS point_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,        -- 양수: 적립, 음수: 사용
  reason      VARCHAR(100) NOT NULL,
  order_id    UUID REFERENCES orders(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════
-- 7. 인덱스
-- ════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_social_accounts_user    ON social_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_social_accounts_provider ON social_accounts(provider, provider_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user     ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token    ON refresh_tokens(token);
CREATE INDEX IF NOT EXISTS idx_orders_user             ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status           ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order       ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user      ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_date ON subscriptions(next_date);
CREATE INDEX IF NOT EXISTS idx_cs_tickets_user         ON cs_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_point_logs_user         ON point_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_products_category       ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active         ON products(is_active);

-- ════════════════════════════════════════════════════════════
-- 8. updated_at 자동 갱신 트리거
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_users_updated       BEFORE UPDATE ON users       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  CREATE TRIGGER trg_orders_updated      BEFORE UPDATE ON orders      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  CREATE TRIGGER trg_products_updated    BEFORE UPDATE ON products    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  CREATE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  CREATE TRIGGER trg_cs_tickets_updated  BEFORE UPDATE ON cs_tickets  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ════════════════════════════════════════════════════════════
-- 9. Row Level Security (RLS) — 사용자 데이터 보호
-- ════════════════════════════════════════════════════════════
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE addresses       ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_tickets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons         ENABLE ROW LEVEL SECURITY;
ALTER TABLE point_logs      ENABLE ROW LEVEL SECURITY;

-- Service Role 은 RLS 우회 가능 (서버에서만 사용)
-- 모든 조회/수정은 백엔드 API 통해서만 허용
