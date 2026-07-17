-- ════════════════════════════════════════════════════════════
-- 09_vendor_matching.sql
-- 벤더 당일배송 매칭 강화: 거리(반경)·마감시간·일일한도 + 좌표 캐시
-- ════════════════════════════════════════════════════════════

-- ── 벤더 당일배송 정책/좌표 ────────────────────────────────
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS same_day_enabled   BOOLEAN     NOT NULL DEFAULT true;   -- 당일배송 운영 on/off
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS same_day_radius_km  NUMERIC(5,1) NOT NULL DEFAULT 8;    -- 허용 반경(km) — 초과 시 버튼 숨김
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS same_day_cutoff     TIME        NOT NULL DEFAULT '14:00';-- 당일 주문 마감(KST)
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS daily_order_limit   INTEGER     NOT NULL DEFAULT 50;    -- 일일 주문 한도
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;  -- 위도 (없으면 대비)
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;  -- 경도

-- ── 회원 배송지 좌표 캐시 (지오코딩 결과 저장) ─────────────
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS latitude    DOUBLE PRECISION;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS longitude   DOUBLE PRECISION;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ;

-- 참고: 거리 반경컷은 KAKAO_REST_API_KEY(Vercel 환경변수) 설정 시 자동 활성화됩니다.
--       키가 없으면 동/권역·마감·한도 매칭만 적용되고 반경컷은 건너뜁니다(안전 폴백).
