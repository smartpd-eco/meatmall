-- ════════════════════════════════════════════════════
--  레이어1(특허): 로트(입고단위)별 유통기한·재고 관리 테이블
--  - 완전 추가(기존 products/orders 등 무변경). 비어 있어도 시스템 정상 동작.
--  - SAMEDAY_LOTRISK 플래그 ON + 이 테이블에 데이터가 있을 때만 폐기위험 계산에 사용.
-- ════════════════════════════════════════════════════

create table if not exists product_lots (
  id            bigserial primary key,
  product_id    uuid        references products(id) on delete cascade,
  vendor_id     bigint,
  lot_code      text,
  received_at   timestamptz default now(),
  expiry_at     timestamptz,               -- 유통기한
  qty_received  integer     default 0,
  qty_remaining integer     default 0,
  status        text        default 'active', -- active | soldout | discarded
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists idx_product_lots_product
  on product_lots(product_id) where status = 'active';
create index if not exists idx_product_lots_vendor
  on product_lots(vendor_id) where status = 'active';

-- RLS: 서버(service role)만 접근 → 정책 없이 잠금 유지(관리자 API 경유)
alter table product_lots enable row level security;
