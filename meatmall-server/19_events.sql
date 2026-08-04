-- ════════════════════════════════════════════════════
--  특허1 확장: 외부 행사정보 기반 수요예측·선제 재고이전
--  공공데이터(한국관광공사 축제정보 등)에서 행사를 수집·저장.
--  전부 신규 테이블, 기존 무변경.
-- ════════════════════════════════════════════════════

create table if not exists events (
  id                bigserial primary key,
  ext_id            text,                 -- 외부 API 콘텐츠ID(중복방지)
  title             text not null,
  lat               double precision,     -- 행사 위치(위도)
  lng               double precision,     -- 행사 위치(경도)
  addr              text,
  start_date        date,
  end_date          date,
  expected_visitors integer,              -- 예상 방문인원(제공 시)
  source            text default 'tourapi',
  created_at        timestamptz default now(),
  unique(ext_id)
);
create index if not exists idx_events_dates on events(start_date, end_date);
alter table events enable row level security;
