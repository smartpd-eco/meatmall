-- ════════════════════════════════════════════════════
--  특허1 확장 2차: 정육점↔정육점 이전 + 이동일자 + 재고 이동 요청 창
-- ════════════════════════════════════════════════════

-- 이전 소스 유형·출발매장·이동(수거·배송) 예정일
alter table stock_transfers add column if not exists from_type      text default 'hq'; -- hq | vendor
alter table stock_transfers add column if not exists from_vendor_id bigint;            -- 정육점→정육점 시 출발 매장
alter table stock_transfers add column if not exists transfer_date  date;              -- 본사 이동 예정일

-- 재고 이동 요청(필요 매장 체크)
create table if not exists stock_transfer_requests (
  id                   bigserial primary key,
  requester_vendor_id  bigint,                       -- 필요 매장(정육점)
  product_id           uuid references products(id),
  item_name            text,
  qty                  numeric,
  note                 text,
  status               text default 'open',          -- open | matched | fulfilled | cancelled
  created_by           text default 'admin',         -- admin | vendor
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);
create index if not exists idx_transfer_req_status on stock_transfer_requests(status, created_at desc);
alter table stock_transfer_requests enable row level security;
