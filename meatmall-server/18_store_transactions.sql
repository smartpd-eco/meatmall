-- ════════════════════════════════════════════════════
--  정육점간 직거래 매입·매출 기록 (재고 이전 승인 시 단가 입력)
--  seller_vendor_id = 매출(출발) 매장 / buyer_vendor_id = 매입(도착) 매장
--  전부 신규 테이블, 기존 무변경.
-- ════════════════════════════════════════════════════

create table if not exists store_transactions (
  id               bigserial primary key,
  transfer_id      bigint references stock_transfers(id) on delete set null,
  seller_vendor_id bigint,     -- 매출(출발 매장)
  buyer_vendor_id  bigint,     -- 매입(도착 매장)
  product_id       uuid references products(id),
  item_name        text,
  qty              numeric not null,
  unit_price       numeric not null,
  supply_amount    numeric not null,   -- 공급가액
  vat              numeric not null,   -- 부가세(10%)
  total_amount     numeric not null,
  transfer_date    date,
  created_at       timestamptz default now()
);
create index if not exists idx_store_tx_seller on store_transactions(seller_vendor_id, created_at desc);
create index if not exists idx_store_tx_buyer  on store_transactions(buyer_vendor_id, created_at desc);
alter table store_transactions enable row level security;
