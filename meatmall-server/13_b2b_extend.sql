-- ════════════════════════════════════════════════════
--  B2B 확장 (설계문서 v1.0 반영) — 전부 컬럼 추가, 기존 무변경
--  업체정보 보강 + 게시판 유형(판매/구매요청/단가문의) 구분
-- ════════════════════════════════════════════════════

-- 업체정보 보강 (문서: 업체정보 = 사업자번호·주소(좌표)·배송권역·담당자·MOQ·결제조건·신용한도)
alter table b2b_members add column if not exists moq            numeric;          -- 최소주문수량(MOQ)
alter table b2b_members add column if not exists payment_terms  text;             -- 결제조건(예: 월말정산/선결제/외상15일)
alter table b2b_members add column if not exists lat            double precision; -- 좌표(거리매칭)
alter table b2b_members add column if not exists lng            double precision;
alter table b2b_members add column if not exists delivery_area  text;             -- 배송권역

-- 게시판 유형 구분 (문서: 판매/긴급재고/특가/공동배송/공동구매/구매요청/단가문의)
--  post_kind: sell(판매) | buy_request(구매요청) | price_inquiry(단가문의)
--  deal_type: surplus·clearance·urgent·special·group_delivery·group_buy 등(판매 세부유형)
alter table b2b_listings add column if not exists post_kind text default 'sell';
