-- ════════════════════════════════════════════════════
--  레이어2(특허): 정육점 가공여력 튜닝 컬럼 (완전 추가, 기존 무변경)
--  - 값이 없으면(NULL) 코드가 기본값(가공 20분/건, 동시 1건)으로 보수적 추정.
--  - VENDOR_CAPACITY_ROUTING 플래그 ON일 때만 사용.
-- ════════════════════════════════════════════════════

alter table vendors add column if not exists avg_prep_min  integer; -- 건당 예상 가공시간(분)
alter table vendors add column if not exists prep_parallel integer; -- 동시 처리 가능 작업대/인력 수
