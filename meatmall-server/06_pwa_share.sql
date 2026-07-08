-- 06. PWA 공유 버튼 + 투명도 80% (플로팅 스택)
ALTER TABLE pwa_settings ADD COLUMN IF NOT EXISTS show_share boolean NOT NULL DEFAULT true;
UPDATE pwa_settings SET opacity = 0.80, updated_at = now() WHERE id = 1;
ALTER TABLE pwa_install_logs DROP CONSTRAINT IF EXISTS pwa_install_logs_event_type_check;
ALTER TABLE pwa_install_logs ADD CONSTRAINT pwa_install_logs_event_type_check
  CHECK (event_type IN ('install_click','install_success','install_cancel','share_click'));
