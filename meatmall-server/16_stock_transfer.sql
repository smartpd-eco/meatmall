-- ════════════════════════════════════════════════════
--  특허1 확장: 본사 임박재고 → 매장 재고 이전 (추천→승인→실행)
--  이전 실행 기록 테이블 (추천은 실시간 계산, 승인 시 이 표에 기록)
--  본사 좌표는 환경변수 HQ_LAT / HQ_LNG (미설정 시 거리컷 생략).
-- ════════════════════════════════════════════════════

create table if not exists stock_transfers (
  id           bigserial primary key,
  lot_id       bigint references product_lots(id) on delete set null,
  product_id   uuid references products(id),
  from_label   text default '본사',
  to_vendor_id bigint,
  qty          numeric not null,
  distance_km  numeric,
  reason       text,
  status       text default 'recommended',  -- recommended | approved | done | rejected
  created_at   timestamptz default now(),
  approved_at  timestamptz
);
create index if not exists idx_stock_transfers_status on stock_transfers(status, created_at desc);
alter table stock_transfers enable row level security;
