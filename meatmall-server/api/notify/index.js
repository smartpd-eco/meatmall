const express = require('express');
const router  = express.Router();
const { SolapiMessageService } = require('solapi');

// ── Solapi 설정 ──────────────────────────────────────
// SOLAPI_PFID: 카카오 비즈니스 채널 pfId (미설정 시 DEV 모드로 폴백)
const SOLAPI = {
  apiKey:    process.env.SOLAPI_API_KEY    || '',
  apiSecret: process.env.SOLAPI_API_SECRET || '',
  pfId:      process.env.SOLAPI_PFID       || '',
  senderNo:  process.env.ALIMTALK_SENDER_NO || '15880000',
};

// 알림톡 템플릿 코드 (Solapi 콘솔 / 카카오 비즈니스 채널 등록 기준)
// 주문완료·배송시작은 카카오 템플릿 심사 승인 후 실제 템플릿ID를 환경변수에 입력해서 사용
// (SOLAPI_TEMPLATE_ORDER_COMPLETE / SOLAPI_TEMPLATE_SHIPPING_START — 승인 전엔 빈 값)
const TEMPLATES = {
  ORDER_COMPLETE:  process.env.SOLAPI_TEMPLATE_ORDER_COMPLETE || '',
  SHIPPING_START:  process.env.SOLAPI_TEMPLATE_SHIPPING_START || '',
  DELIVERY_DONE:   'TM_DELIVERY_DONE',
  PAYMENT_FAIL:    'TM_PAYMENT_FAIL',
  SUBSCRIBE_FAIL:  'TM_SUBSCRIBE_FAIL',
  CS_ANSWER:       'TM_CS_ANSWER',
  ADMIN_NEW_ORDER: 'TM_ADMIN_ORDER',
};

// ── 알림톡 발송 공통 함수 ────────────────────────────────
// DEV 폴백 조건: SOLAPI_PFID 미설정(채널 미연동) 또는 API 키 미설정
// 템플릿ID가 비어있으면(카카오 심사 승인 전) 발송 자체를 시도하지 않고 건너뜀
async function sendAlimtalk({ to, templateCode, params }) {
  if (!SOLAPI.apiKey || !SOLAPI.apiSecret || !SOLAPI.pfId) {
    console.log(`[알림톡 DEV] to:${to} template:${templateCode}`, params);
    return { ok: true, dev: true };
  }

  if (!templateCode) {
    console.log(`[알림톡] 템플릿 미승인 - 발송 건너뜀 (to:${to})`);
    return { ok: true, skipped: true };
  }

  try {
    const service = new SolapiMessageService(SOLAPI.apiKey, SOLAPI.apiSecret);
    const result  = await service.send({
      to:   to.replace(/-/g, ''),
      from: SOLAPI.senderNo,
      kakaoOptions: {
        pfId:       SOLAPI.pfId,
        templateId: templateCode,
        variables:  params,
      },
    });
    return { ok: true, data: result };
  } catch (err) {
    console.error('[솔라피 알림톡 발송 오류]', err.message || err);
    return { ok: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════
// 결제 완료 알림 (소비자)
// ════════════════════════════════════════════════════
async function notifyOrderComplete({ phone, name, orderId, amount, items, deliveryDate }) {
  return sendAlimtalk({
    to:           phone,
    templateCode: TEMPLATES.ORDER_COMPLETE,
    params: {
      '#{고객명}':   name,
      '#{주문번호}': orderId,
      '#{상품명}':   items,
      '#{결제금액}': Number(amount).toLocaleString('ko-KR') + '원',
      '#{배송예정}': deliveryDate,
    },
  });
}

// ════════════════════════════════════════════════════
// 배송 시작 알림 (소비자)
// ════════════════════════════════════════════════════
async function notifyShippingStart({ phone, name, orderId, carrier, trackingNumber }) {
  return sendAlimtalk({
    to:           phone,
    templateCode: TEMPLATES.SHIPPING_START,
    params: {
      '#{고객명}':     name,
      '#{주문번호}':   orderId,
      '#{택배사}':     carrier || 'CJ대한통운',
      '#{운송장번호}': trackingNumber,
    },
  });
}

// ════════════════════════════════════════════════════
// 결제 실패 알림 (정기배송 미납)
// ════════════════════════════════════════════════════
async function notifyPaymentFail({ phone, name, orderId, retryDate }) {
  return sendAlimtalk({
    to:           phone,
    templateCode: TEMPLATES.PAYMENT_FAIL,
    params: {
      '#{고객명}':   name,
      '#{주문번호}': orderId,
      '#{재결제일}': retryDate,
    },
  });
}

// ════════════════════════════════════════════════════
// CS 답변 알림 (소비자)
// ════════════════════════════════════════════════════
async function notifyCSAnswer({ phone, name, ticketId, answer }) {
  return sendAlimtalk({
    to:           phone,
    templateCode: TEMPLATES.CS_ANSWER,
    params: {
      '#{고객명}':   name,
      '#{문의번호}': ticketId,
      '#{답변내용}': answer.slice(0, 100) + (answer.length > 100 ? '...' : ''),
    },
  });
}

// ════════════════════════════════════════════════════
// 관리자 신규 주문 알림 (결제 완료 시 내부 발송)
// ADMIN_PHONE 미설정 시 콘솔 로그만
// ════════════════════════════════════════════════════
async function notifyAdminNewOrder({ orderId, amount, recipient, items, paymentMethod }) {
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone) {
    console.log(`[알림톡 DEV] 관리자알림 (ADMIN_PHONE 미설정) orderId:${orderId} amount:${amount} recipient:${recipient}`);
    return { ok: true, dev: true };
  }
  return sendAlimtalk({
    to:           adminPhone,
    templateCode: TEMPLATES.ADMIN_NEW_ORDER,
    params: {
      '#{주문번호}': orderId,
      '#{상품명}':   items,
      '#{결제금액}': Number(amount).toLocaleString('ko-KR') + '원',
      '#{결제수단}': paymentMethod || '카드',
      '#{수령인}':   recipient,
    },
  });
}

// ════════════════════════════════════════════════════
// HTTP 엔드포인트 (수동 발송 / 외부 트리거용)
// ════════════════════════════════════════════════════

router.post('/order-complete', async (req, res) => {
  try {
    const { phone, name, orderId, amount, items, deliveryDate } = req.body;
    const result = await notifyOrderComplete({ phone, name, orderId, amount, items, deliveryDate });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: '알림 발송 오류' });
  }
});

router.post('/shipping', async (req, res) => {
  try {
    const { phone, name, orderId, carrier, trackingNumber } = req.body;
    const result = await notifyShippingStart({ phone, name, orderId, carrier, trackingNumber });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: '알림 발송 오류' });
  }
});

router.post('/payment-fail', async (req, res) => {
  try {
    const { phone, name, orderId, retryDate } = req.body;
    const result = await notifyPaymentFail({ phone, name, orderId, retryDate });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: '알림 발송 오류' });
  }
});

router.post('/cs-answer', async (req, res) => {
  try {
    const { phone, name, ticketId, answer } = req.body;
    const result = await notifyCSAnswer({ phone, name, ticketId, answer });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: '알림 발송 오류' });
  }
});

module.exports = router;
module.exports.notifyOrderComplete  = notifyOrderComplete;
module.exports.notifyShippingStart  = notifyShippingStart;
module.exports.notifyPaymentFail    = notifyPaymentFail;
module.exports.notifyCSAnswer       = notifyCSAnswer;
module.exports.notifyAdminNewOrder  = notifyAdminNewOrder;
