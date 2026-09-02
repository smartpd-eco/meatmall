-- 기존 포인트 로그를 기준으로 회원 잔액을 1회 보정한다.
-- 가입 적립, 관리자 조정, 주문 사용/적립/환불 로그의 합계가 최종 잔액이다.
UPDATE users AS u
SET point = COALESCE((
  SELECT SUM(pl.amount)::INTEGER
  FROM point_logs AS pl
  WHERE pl.user_id = u.id
), 0),
updated_at = NOW()
WHERE EXISTS (
  SELECT 1 FROM point_logs AS existing WHERE existing.user_id = u.id
);
