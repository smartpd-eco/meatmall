-- ════════════════════════════════════════════════════
--  B2B 공개범위·단가공개·알림 (전부 추가, 기존 무변경)
--  visibility        : public(전체공개) | private(비공개=초안) | selected(선택업체)
--  price_visibility  : public(단가공개) | inquiry(문의) | selected(선택업체만)
--  allowed_members   : 선택업체 공개 대상(b2b_members.id 배열)
-- ════════════════════════════════════════════════════

alter table b2b_listings add column if not exists visibility       text   default 'public';
alter table b2b_listings add column if not exists price_visibility text   default 'public';
alter table b2b_listings add column if not exists allowed_members  bigint[] default '{}';

-- 앱 내 알림
create table if not exists b2b_notifications (
  id         bigserial primary key,
  member_id  bigint references b2b_members(id) on delete cascade,
  listing_id bigint references b2b_listings(id) on delete cascade,
  type       text default 'new_listing',
  title      text,
  body       text,
  is_read    boolean default false,
  created_at timestamptz default now()
);
create index if not exists idx_b2b_noti_member on b2b_notifications(member_id, is_read, created_at desc);
alter table b2b_notifications enable row level security;
