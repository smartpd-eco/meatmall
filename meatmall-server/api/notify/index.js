const express = require('express');
const router  = express.Router();
const fetch   = require('node-fetch');

// ── 카카오 알림톡 설정 ────────────────────────────────────
const KAKAO = {
  apiKey:      process.env.KAKAO_ALIMTALK_API_KEY || '',
  senderKey:   process.env.KAKAO_ALIMTALK_SENDER_KEY || '',
  baseURL:     'https://api-alimtalk.kakao.com/v2',
  // 템플릿 코드 (카카오 비즈니스 채널 등록 필요)
  templates: {
    ORDER_COMPLETE:  'TM_ORDER_COMPLETE',
    SHIPPING_START:  'TM_SHIPPING_START',
    DELIVERY_DONE:   'TM_DELIVERY_DONE',
    PAYMENT_FAIL:    'TM_PAYMENT_FAIL',
    SUBSCRIBE_FAIL:  'TM_SUBSCRIBE_FAIL',
    CS_ANSWER:       'TM_CS_ANSWER',
  }
};

// ── 알림톡 발송 공통 함수 ─────────────────────────────────
async function sendAlimtalk({ to, templateCode, params, failover = true }) {
  // 카카오 알림톡 미설정 시 콘솔 로그로 대체 (개발 모드)
  if (!KAKAO.apiKey || !KAKAO.senderKey) {
    console.log(`[알림톡 DEV] to:${to} template:${templateCode}`, params);
    return { ok: true, dev: true };
  }

  try {
    const body = {
      senderKey: KAKAO.senderKey,
      templateCode,
      recipientList: [{
        recipientNo: to.replace(/-/g, ''),
        templateParameter: params,
        ...(failover && {
          senderGroupingKey: 'meatmall',
          failoverConfig: {
            type: 'SMS',
            sendNo: process.env.ALIMTALK_SENDER_NO || '15880000',
            body: Object.values(params).join('\n')
          }
        })
      }]
    };

    const res = await fetch(`${KAKAO.baseURL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json;charset=UTF-8',
        'Authorization': KAKAO.apiKey
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (err) {
    console.error('[알림톡 발송 오류]', err);
    return { ok: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════
// 결제 완료 알림
// ════════════════════════════════════════════════════
async function notifyOrderComplete({ phone, name, orderId, amount, items, deliveryDate }) {
  return sendAlimtalk({
    to: phone,
    templateCode: KAKAO.templates.ORDER_COMPLETE,
    params: {
      '#{고객명}':   name,
      '#{주문번호}': orderId,
      '#{상품명}':   items,
      '#{결제금액}': Number(amount).toLocaleString('ko-KR') + '원',
      '#{배송예정}': deliveryDate,
    }
  });
}

// ════════════════════════════════════════════════════
// 배송 시작 알림
// ════════════════════════════════════════════════════
async function notifyShippingStart({ phone, name, orderId, carrier, trackingNumber }) {
  return sendAlimtalk({
    to: phone,
    templateCode: KAKAO.templates.SHIPPING_START,
    params: {
      '#{고객명}':    name,
      '#{주문번호}':  orderId,
      '#{택배사}':    carrier || 'CJ대한통운',
      '#{운송장번호}': trackingNumber,
    }
  });
}

// ════════════════════════════════════════════════════
// 결제 실패 알림 (정기배송 미납)
// ════════════════════════════════════════════════════
async function notifyPaymentFail({ phone, name, orderId, retryDate }) {
  return sendAlimtalk({
    to: phone,
    templateCode: KAKAO.templates.PAYMENT_FAIL,
    params: {
      '#{고객명}':    name,
      '#{주문번호}':  orderId,
      '#{재결제일}':  retryDate,
    }
  });
}

// ════════════════════════════════════════════════════
// CS 답변 알림
// ════════════════════════════════════════════════════
async function notifyCSAnswer({ phone, name, ticketId, answer }) {
  return sendAlimtalk({
    to: phone,
    templateCode: KAKAO.templates.CS_ANSWER,
    params: {
      '#{고객명}':    name,
      '#{문의번호}':  ticketId,
      '#{답변내용}':  answer.slice(0, 100) + (answer.length > 100 ? '...' : ''),
    }
  });
}

// ════════════════════════════════════════════════════
// POST /api/notify/order-complete — 결제 완료 알림 발송
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

// ════════════════════════════════════════════════════
// POST /api/notify/shipping — 배송 시작 알림
// ════════════════════════════════════════════════════
router.post('/shipping', async (req, res) => {
  try {
    const { phone, name, orderId, carrier, trackingNumber } = req.body;
    const result = await notifyShippingStart({ phone, name, orderId, carrier, trackingNumber });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: '알림 발송 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/notify/payment-fail — 결제 실패 알림
// ════════════════════════════════════════════════════
router.post('/payment-fail', async (req, res) => {
  try {
    const { phone, name, orderId, retryDate } = req.body;
    const result = await notifyPaymentFail({ phone, name, orderId, retryDate });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: '알림 발송 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/notify/cs-answer — CS 답변 알림
// ════════════════════════════════════════════════════
router.post('/cs-answer', async (req, res) => {
  try {
    const { phone, name, ticketId, answer } = req.body;
    const result = await notifyCSAnswer({ phone, name, ticketId, answer });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: '알림 발송 오류' });
  }
});

// 외부 모듈에서 직접 호출 가능하도록 export
module.exports = router;
module.exports.notifyOrderComplete  = notifyOrderComplete;
module.exports.notifyShippingStart  = notifyShippingStart;
module.exports.notifyPaymentFail    = notifyPaymentFail;
module.exports.notifyCSAnswer       = notifyCSAnswer;
