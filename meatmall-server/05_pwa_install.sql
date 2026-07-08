-- ════════════════════════════════════════════════════
-- 05. PWA 설치 플로팅 버튼 (MD_031)
--   pwa_settings      : 관리자 설정 (단일 행 id=1)
--   pwa_install_logs  : 설치 이벤트 통계
-- 기존 테이블 변경 없음 · 추가만 수행 (안전)
-- ════════════════════════════════════════════════════

-- 1) 관리자 설정
CREATE TABLE IF NOT EXISTS pwa_settings (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled     boolean       NOT NULL DEFAULT true,
  position    text          NOT NULL DEFAULT 'bottom-right'
              CHECK (position IN ('bottom-right','bottom-left')),
  opacity     numeric(3,2)  NOT NULL DEFAULT 0.60
              CHECK (opacity >= 0.20 AND opacity <= 1.00),
  show_toast  boolean       NOT NULL DEFAULT true,
  updated_at  timestamptz   NOT NULL DEFAULT now()
);

INSERT INTO pwa_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- 2) 설치 이벤트 로그
CREATE TABLE IF NOT EXISTS pwa_install_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type  text NOT NULL
              CHECK (event_type IN ('install_click','install_success','install_cancel')),
  browser     text,
  os          text,
  device_type text CHECK (device_type IN ('mobile','desktop')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pwa_logs_created ON pwa_install_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pwa_logs_event   ON pwa_install_logs (event_type);

-- 3) RLS (서버는 service role로 접근하므로 우회됨 · 익명 직접 접근 차단)
ALTER TABLE pwa_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pwa_install_logs ENABLE ROW LEVEL SECURITY;
