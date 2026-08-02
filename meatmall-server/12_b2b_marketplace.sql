-- ════════════════════════════════════════════════════
--  B2B 잉여/임박 재고 거래소 — 데이터 모델 (전부 신규 테이블, 기존 무변경)
--  회원(사업자) · 게시글(판매) · 거래 · 여신원장 · 세금계산서
-- ════════════════════════════════════════════════════

-- ── B2B 사업자 회원 (users에 연결, 사업자번호 인증 후 승인) ──
create table if not exists b2b_members (
  id            bigserial primary key,
  user_id       uuid references users(id) on delete cascade,
  company_name  text not null,
  biz_reg_no    text not null,               -- 사업자등록번호
  ceo_name      text,
  biz_type      text,                        -- 업태
  biz_item      text,                        -- 종목
  address       text,
  contact_phone text,
  contact_email text,
  tax_email     text,                        -- 세금계산서 수신 이메일
  status        text default 'pending',      -- pending | approved | rejected | suspended
  credit_limit  numeric default 0,           -- 여신 한도(원)
  credit_used   numeric default 0,           -- 현재 미수(사용) 금액
  approved_at   timestamptz,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique(user_id)
);
create index if not exists idx_b2b_members_bizno on b2b_members(biz_reg_no);

-- ── B2B 판매 게시글 (잉여/임박 재고) ──
create table if not exists b2b_listings (
  id            bigserial primary key,
  seller_id     bigint references b2b_members(id) on delete cascade,
  title         text not null,
  item_name     text not null,               -- 품목(삼겹 등)
  category      text,
  deal_type     text default 'surplus',      -- surplus(잉여) | clearance(임박덤핑) | regular
  qty_total     numeric not null,            -- 총 판매수량
  qty_remaining numeric not null,
  unit          text default 'kg',           -- kg | ton | box
  unit_price    numeric not null,            -- 단가(원)
  origin        text,
  expiry_at     timestamptz,                 -- 유통기한(임박거래)
  storage       text,                        -- 냉장 | 냉동
  delivery_type text,                        -- 직접수령 | 택배 | 화물 | 공동배송
  delivery_info text,                        -- 배송정보 상세
  region        text,
  description   text,
  images        jsonb default '[]',
  status        text default 'open',         -- open | reserved | soldout | closed
  view_count    int default 0,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists idx_b2b_listings_status on b2b_listings(status, created_at desc);
create index if not exists idx_b2b_listings_seller on b2b_listings(seller_id);

-- ── B2B 거래 (구매요청 → 성사 → 정산) ──
create table if not exists b2b_deals (
  id            bigserial primary key,
  deal_no       text unique,
  listing_id    bigint references b2b_listings(id),
  seller_id     bigint references b2b_members(id),
  buyer_id      bigint references b2b_members(id),
  item_name     text,
  qty           numeric not null,
  unit          text,
  unit_price    numeric not null,
  supply_amount numeric not null,            -- 공급가액
  vat           numeric not null,            -- 부가세(10%)
  total_amount  numeric not null,            -- 합계
  pay_method    text default 'credit',       -- credit(외상/여신)
  delivery_type text,
  delivery_info text,
  status        text default 'requested',    -- requested | accepted | rejected | delivering | delivered | settled | cancelled
  settle_due    date,                        -- 정산(지급) 예정일
  settled_at    timestamptz,
  note          text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists idx_b2b_deals_buyer  on b2b_deals(buyer_id, created_at desc);
create index if not exists idx_b2b_deals_seller on b2b_deals(seller_id, created_at desc);

-- ── 여신/미수금 원장 ──
create table if not exists b2b_credit_ledger (
  id            bigserial primary key,
  member_id     bigint references b2b_members(id),
  deal_id       bigint references b2b_deals(id),
  entry_type    text,                        -- charge(미수발생) | payment(상환) | adjust
  amount        numeric not null,            -- +미수 증가 / -상환
  balance_after numeric,
  memo          text,
  created_at    timestamptz default now()
);
create index if not exists idx_b2b_credit_member on b2b_credit_ledger(member_id, created_at desc);

-- ── 세금계산서 발행 기록 (전자세금계산서 대행사 연동) ──
create table if not exists b2b_tax_invoices (
  id             bigserial primary key,
  deal_id        bigint references b2b_deals(id),
  supplier_id    bigint references b2b_members(id),   -- 공급자(판매자)
  buyer_id       bigint references b2b_members(id),   -- 공급받는자(구매자)
  supply_amount  numeric not null,
  vat            numeric not null,
  total_amount   numeric not null,
  provider       text,                        -- popbill | barobill | manual
  provider_mgt_key text,                       -- 대행사 문서관리번호
  nts_confirm_no text,                          -- 국세청 승인번호
  status         text default 'pending',       -- pending | issued | failed | cancelled
  issued_at      timestamptz,
  pdf_url        text,
  error_msg      text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create index if not exists idx_b2b_tax_deal on b2b_tax_invoices(deal_id);

-- RLS: 서버(service role)만 접근 → API 경유로만 조작
alter table b2b_members       enable row level security;
alter table b2b_listings      enable row level security;
alter table b2b_deals         enable row level security;
alter table b2b_credit_ledger enable row level security;
alter table b2b_tax_invoices  enable row level security;
