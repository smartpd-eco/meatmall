-- ════════════════════════════════════════════════════
--  B2B 계약단가 엔진 (설계문서: 1:1/1:N 계약 · 단가 우선순위)
--  단가 우선순위: 계약단가 > 등급단가 > 행사단가 > 기본단가
--  전부 신규 테이블/컬럼, 기존 무변경.
-- ════════════════════════════════════════════════════

-- 거래처 등급(등급단가용)
alter table b2b_members add column if not exists grade text default 'basic'; -- basic|silver|gold|vip

-- 거래처 계약(공급자↔거래처 관계 + 계약조건)
create table if not exists b2b_contracts (
  id            bigserial primary key,
  seller_id     bigint references b2b_members(id) on delete cascade, -- 공급자(판매자)
  buyer_id      bigint references b2b_members(id) on delete cascade, -- 거래처(구매자)
  status        text default 'active',   -- active | paused | ended
  payment_terms text,                    -- 계약 결제조건
  moq           numeric,                 -- 계약 MOQ
  note          text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique(seller_id, buyer_id)
);
create index if not exists idx_b2b_contracts_seller on b2b_contracts(seller_id);
create index if not exists idx_b2b_contracts_buyer  on b2b_contracts(buyer_id);

-- 계약단가(거래처별 품목 단가)
create table if not exists b2b_contract_prices (
  id         bigserial primary key,
  seller_id  bigint references b2b_members(id) on delete cascade,
  buyer_id   bigint references b2b_members(id) on delete cascade,
  item_name  text not null,
  category   text,
  unit_price numeric not null,
  min_qty    numeric default 0,   -- 이 수량 이상일 때 적용
  valid_from date,
  valid_to   date,
  active     boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_b2b_cprice on b2b_contract_prices(seller_id, buyer_id, active);

-- 등급단가(공급자별 등급·품목 단가) — 우선순위 2
create table if not exists b2b_grade_prices (
  id         bigserial primary key,
  seller_id  bigint references b2b_members(id) on delete cascade,
  grade      text not null,
  item_name  text not null,
  unit_price numeric not null,
  active     boolean default true,
  created_at timestamptz default now()
);
create index if not exists idx_b2b_gprice on b2b_grade_prices(seller_id, grade, active);

alter table b2b_contracts       enable row level security;
alter table b2b_contract_prices enable row level security;
alter table b2b_grade_prices    enable row level security;
