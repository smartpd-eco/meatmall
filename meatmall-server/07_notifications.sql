-- 07. 카카오 알림톡 발송 로그 (Solapi)
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  receiver_phone text not null,
  receiver_name text,
  template_code text,
  payload jsonb,
  status text default 'pending',
  sent_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists notification_logs (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid,
  provider text default 'solapi',
  success boolean default false,
  result_code text,
  result_message text,
  raw_response jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_notifications_type_status on notifications (type, status);
create index if not exists idx_notifications_created on notifications (created_at desc);
create index if not exists idx_notilogs_notiid on notification_logs (notification_id);

alter table notifications     enable row level security;
alter table notification_logs enable row level security;
