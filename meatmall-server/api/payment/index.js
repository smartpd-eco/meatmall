const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../../lib/supabase');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { notifyOrderComplete, notifyAdminNewOrder } = require('../notify/index');

// ══════════════════════════════════════════════════
// 나이스페이먼츠 설정 — 키값만 Vercel 환경변수에 등록하면 됨
// ══════════════════════════════════════════════════
const NICE = {
  clientKey: process.env.NICE_CLIENT_KEY  || 'test_ck_docs_Jz9BYo1zelvxd10pR0rl',
  secretKey: process.env.NICE_SECRET_KEY  || 'test_sk_docs_OePez1rFSehN5kNm8dEW',
  baseURL:   'https://api.nicepay.co.kr/v1',
  isTest:    !process.env.NICE_CLIENT_KEY,  // 운영 키 없으면 테스트 모드
};

// 무통장 계좌 정보 — 환경변수로 관리
const VBANK = {
  bank:    process.env.VBANK_BANK    || '기업은행',
  account: process.env.VBANK_ACCOUNT || '123-456789-01-001',
  holder:  process.env.VBANK_HOLDER  || '(주)정육본가',
};

function niceAuth() {
  return 'Basic ' + Buffer.from(`${NICE.secretKey}:`).toString('base64');
}
function makeOrderNo() {
  const d = new Date().toISOString().slice(0,10).replace(/-/g,'');
  return `ORD-${d}-${uuidv4().slice(0,6).toUpperCase()}`;
}

// ══════════════════════════════════════════════════
// GET /api/payment/config  — 프론트에 결제 설정 전달
// ══════════════════════════════════════════════════
router.get('/config', (req, res) => {
  res.json({
    ok: true,
    clientKey: NICE.clientKey,
    isTest: NICE.isTest,
    vbank: VBANK,
    methods: ['CARD','KAKAO','NAVER','TOSS','VBANK','PHONE'],
    freeShipping: 50000,
    deliveryFee: 3500,
  });
});

// ══════════════════════════════════════════════════
// POST /api/payment/ready  — 주문 생성
// ══════════════════════════════════════════════════
router.post('/ready', requireAuth, async (req, res) => {
  try {
    const {
      items, recipient, phone, zipCode, address1, address2,
      deliveryNote, couponId, pointUse=0,
      paymentMethod='CARD', depositorName, bankName
    } = req.body;

    if (!items?.length) return res.status(400).json({ error:'주문 상품이 없습니다' });
    if (!recipient || !phone || !zipCode || !address1)
      return res.status(400).json({ error:'배송지 정보를 입력해주세요' });

    const userId       = req.user.sub;
    const productTotal = items.reduce((s,i) => s + i.price * i.qty, 0);
    const deliveryFee  = productTotal >= 50000 ? 0 : 3500;
    const couponDisc   = 0; // 쿠폰 추후 적용
    const finalAmount  = Math.max(100, productTotal + deliveryFee - couponDisc - Number(pointUse));
    const isVbank      = paymentMethod === 'VBANK';
    const orderNumber  = makeOrderNo();

    // 기본 주문 데이터
    const orderData = {
      order_number:    orderNumber,
      user_id:         userId,
      status:          isVbank ? 'pending_deposit' : 'pending',
      recipient, phone, zip_code: zipCode, address1, address2: address2||null,
      delivery_note:   deliveryNote||null,
      product_total:   productTotal,
      delivery_fee:    deliveryFee,
      discount_amount: couponDisc,
      point_used:      Number(pointUse),
      final_amount:    finalAmount,
      payment_method:  paymentMethod,
      payment_status:  isVbank ? 'awaiting_deposit' : 'unpaid',
    };

    // 무통장 컬럼은 존재할 때만 추가 (스키마 마이그레이션 전 호환)
    if (isVbank) {
      try {
        orderData.bank_name        = bankName || VBANK.bank;
        orderData.depositor_name   = depositorName || null;
        orderData.deposit_deadline = new Date(Date.now()+3*86400000).toISOString();
      } catch(e) {}
    }

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert(orderData)
      .select('id, order_number').single();

    if (orderErr) throw orderErr;

    await supabase.from('order_items').insert(
      items.map(i => ({
        order_id: order.id, product_id: i.productId||null,
        name: i.name, option: i.option||null,
        price: i.price, qty: i.qty, subtotal: i.price*i.qty,
      }))
    );

    // 포인트 차감
    if (Number(pointUse) > 0) {
      await supabase.from('point_logs').insert({
        user_id:userId, amount:-Number(pointUse),
        reason:`주문 ${orderNumber} 포인트 사용`, order_id:order.id,
      });
    }

    const orderName = items.length > 1
      ? `${items[0].name} 외 ${items.length-1}건` : items[0].name;

    res.json({
      ok: true,
      order: {
        orderId: orderNumber, orderName,
        amount: finalAmount, productTotal, deliveryFee,
        paymentMethod, isVbank,
        ...(isVbank && {
          bankInfo: {
            bank:     bankName || VBANK.bank,
            account:  VBANK.account,
            holder:   VBANK.holder,
            deadline: new Date(Date.now()+3*86400000).toLocaleDateString('ko-KR'),
            amount:   finalAmount,
          }
        })
      },
      nice: { clientKey: NICE.clientKey, isTest: NICE.isTest },
    });
  } catch(err) {
    console.error('[payment/ready]', err);
    res.status(500).json({ error:'주문 생성 오류: '+err.message });
  }
});

// ══════════════════════════════════════════════════
// POST /api/payment/confirm  — 카드/간편결제 승인
// ══════════════════════════════════════════════════
router.post('/confirm', requireAuth, async (req, res) => {
  try {
    const { paymentKey, orderId, amount } = req.body;
    if (!paymentKey||!orderId||!amount)
      return res.status(400).json({ error:'결제 정보가 올바르지 않습니다' });

    const { data: order } = await supabase
      .from('orders').select('id,final_amount,payment_status,user_id,phone,recipient,payment_method')
      .eq('order_number', orderId).single();

    if (!order)            return res.status(404).json({ error:'주문을 찾을 수 없습니다' });
    if (order.user_id !== req.user.sub) return res.status(403).json({ error:'접근 권한 없음' });
    if (order.payment_status === 'paid') return res.status(400).json({ error:'이미 결제된 주문' });
    if (order.final_amount !== Number(amount)) return res.status(400).json({ error:'결제 금액 불일치' });

    // 테스트 모드: 나이스 API 호출 생략
    if (!NICE.isTest) {
      const niceRes = await fetch(`${NICE.baseURL}/payments/confirm`, {
        method:'POST',
        headers:{ Authorization:niceAuth(), 'Content-Type':'application/json' },
        body: JSON.stringify({ paymentKey, orderId, amount:Number(amount) })
      });
      const nd = await niceRes.json();
      if (!niceRes.ok || nd.resultCode !== '0000')
        return res.status(400).json({ error: nd.resultMsg||'결제 승인 실패' });
    }

    await supabase.from('orders').update({
      status:'preparing', payment_status:'paid',
      payment_key:paymentKey, paid_at:new Date().toISOString(),
    }).eq('order_number', orderId);

    const pt = Math.floor(Number(amount)*0.01);
    if (pt > 0) {
      await supabase.from('point_logs').insert({
        user_id:order.user_id, amount:pt,
        reason:`주문 ${orderId} 결제 포인트 적립`, order_id:order.id,
      });
    }

    // ── 소비자 결제완료 알림 + 관리자 신규주문 알림 (비동기, 결제 응답에 영향 없음)
    if (order.phone) {
      notifyOrderComplete({
        phone:        order.phone,
        name:         order.recipient || '고객',
        orderId,
        amount:       order.final_amount,
        items:        '주문 상품',
        deliveryDate: '3~5 영업일 이내',
      }).catch(e => console.error('[결제완료 알림 오류]', e));
    }
    notifyAdminNewOrder({
      orderId,
      amount:        order.final_amount,
      recipient:     order.recipient || '-',
      items:         '주문 상품',
      paymentMethod: order.payment_method || '카드',
    }).catch(e => console.error('[관리자 알림 오류]', e));

    res.json({ ok:true, orderId, amount:Number(amount), pointEarned:pt, message:'결제 완료' });
  } catch(err) {
    console.error('[payment/confirm]', err);
    res.status(500).json({ error:'결제 처리 오류' });
  }
});

// ══════════════════════════════════════════════════
// POST /api/payment/vbank-confirm  — 무통장 입금 확인 (관리자)
// ══════════════════════════════════════════════════
router.post('/vbank-confirm', requireAdmin, async (req, res) => {
  try {
    const { orderId, depositorName, depositAmount } = req.body;
    const { data:order } = await supabase
      .from('orders').select('id,final_amount,payment_status,user_id,phone,recipient,payment_method')
      .eq('order_number', orderId).single();

    if (!order) return res.status(404).json({ error:'주문 없음' });
    if (order.payment_status === 'paid') return res.status(400).json({ error:'이미 입금 확인됨' });
    if (depositAmount && Number(depositAmount) !== order.final_amount)
      return res.status(400).json({ error:`금액 불일치 (주문:${order.final_amount}원 / 입금:${depositAmount}원)` });

    await supabase.from('orders').update({
      status:'preparing', payment_status:'paid',
      depositor_name:depositorName||null, paid_at:new Date().toISOString(),
    }).eq('order_number', orderId);

    const pt = Math.floor(order.final_amount*0.01);
    if (pt>0) await supabase.from('point_logs').insert({
      user_id:order.user_id, amount:pt,
      reason:`주문 ${orderId} 무통장 입금 적립`, order_id:order.id,
    });

    // ── 무통장 입금 확인 시 소비자·관리자 알림
    if (order.phone) {
      notifyOrderComplete({
        phone:        order.phone,
        name:         order.recipient || '고객',
        orderId,
        amount:       order.final_amount,
        items:        '주문 상품',
        deliveryDate: '3~5 영업일 이내',
      }).catch(e => console.error('[입금확인 알림 오류]', e));
    }
    notifyAdminNewOrder({
      orderId,
      amount:        order.final_amount,
      recipient:     order.recipient || '-',
      items:         '주문 상품',
      paymentMethod: '무통장입금',
    }).catch(e => console.error('[관리자 알림 오류]', e));

    res.json({ ok:true, message:'입금 확인 완료. 준비중으로 변경됐습니다.', orderId, pointEarned:pt });
  } catch(err) {
    res.status(500).json({ error:'입금 확인 오류' });
  }
});

// ══════════════════════════════════════════════════
// POST /api/payment/cancel  — 주문 취소/환불
// ══════════════════════════════════════════════════
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const { orderId, reason='고객 요청', cancelAmt } = req.body;
    const { data:order } = await supabase
      .from('orders').select('id,payment_key,payment_status,final_amount,user_id,status,payment_method')
      .eq('order_number', orderId).single();

    if (!order) return res.status(404).json({ error:'주문 없음' });
    if (order.user_id !== req.user.sub) return res.status(403).json({ error:'권한 없음' });
    if (['shipping','delivered'].includes(order.status))
      return res.status(400).json({ error:'배송 중/완료된 주문은 취소 불가' });

    // 무통장 입금 대기 → 즉시 취소
    if (order.payment_method==='VBANK' && order.payment_status==='awaiting_deposit') {
      await supabase.from('orders').update({
        status:'cancelled', payment_status:'cancelled'
      }).eq('order_number', orderId);
      return res.json({ ok:true, message:'주문이 취소됐습니다', orderId });
    }

    if (order.payment_status !== 'paid')
      return res.status(400).json({ error:'결제된 주문만 취소 가능' });

    // 운영 모드: 나이스 취소 API
    if (!NICE.isTest && order.payment_key) {
      const niceRes = await fetch(`${NICE.baseURL}/payments/${order.payment_key}/cancel`, {
        method:'POST',
        headers:{ Authorization:niceAuth(), 'Content-Type':'application/json' },
        body: JSON.stringify({ reason, cancelAmt: cancelAmt||order.final_amount })
      });
      const nd = await niceRes.json();
      if (!niceRes.ok || nd.resultCode !== '0000')
        return res.status(400).json({ error: nd.resultMsg||'취소 실패' });
    }

    await supabase.from('orders').update({
      status:'cancelled', payment_status:'refunded'
    }).eq('order_number', orderId);

    // 포인트 환불
    if (order.point_used > 0) {
      await supabase.from('point_logs').insert({
        user_id:order.user_id, amount:order.point_used,
        reason:`주문 ${orderId} 취소 포인트 환불`, order_id:order.id,
      });
    }

    res.json({ ok:true, message:'주문이 취소됐습니다', orderId });
  } catch(err) {
    res.status(500).json({ error:'취소 처리 오류' });
  }
});

// ══════════════════════════════════════════════════
// POST /api/payment/partial-cancel  — 부분 취소 (관리자)
// ══════════════════════════════════════════════════
router.post('/partial-cancel', requireAdmin, async (req, res) => {
  try {
    const { orderId, cancelAmt, reason='부분 취소' } = req.body;
    if (!cancelAmt) return res.status(400).json({ error:'취소 금액을 입력해주세요' });

    const { data:order } = await supabase
      .from('orders').select('id,payment_key,payment_status,final_amount')
      .eq('order_number', orderId).single();

    if (!order || order.payment_status !== 'paid')
      return res.status(400).json({ error:'결제된 주문만 부분 취소 가능' });

    if (!NICE.isTest && order.payment_key) {
      const niceRes = await fetch(`${NICE.baseURL}/payments/${order.payment_key}/cancel`, {
        method:'POST',
        headers:{ Authorization:niceAuth(), 'Content-Type':'application/json' },
        body: JSON.stringify({ reason, cancelAmt:Number(cancelAmt) })
      });
      const nd = await niceRes.json();
      if (!niceRes.ok || nd.resultCode !== '0000')
        return res.status(400).json({ error: nd.resultMsg||'부분 취소 실패' });
    }

    await supabase.from('orders').update({
      status:'partial_cancel',
      partial_cancel_amount: Number(cancelAmt),
    }).eq('order_number', orderId);

    res.json({ ok:true, message:`${Number(cancelAmt).toLocaleString()}원 부분 취소 완료`, orderId });
  } catch(err) {
    res.status(500).json({ error:'부분 취소 오류' });
  }
});

// ══════════════════════════════════════════════════
// GET /api/payment/orders  — 내 주문 목록
// ══════════════════════════════════════════════════
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const { status, page=1, limit=10 } = req.query;
    const offset = (page-1)*limit;
    let q = supabase.from('orders')
      .select('*, order_items(*)', { count:'exact' })
      .eq('user_id', req.user.sub)
      .order('created_at',{ ascending:false })
      .range(offset, offset+Number(limit)-1);
    if (status) q = q.eq('status', status);
    const { data:orders, count, error } = await q;
    if (error) throw error;
    res.json({ ok:true, orders, total:count, page:Number(page) });
  } catch(err) {
    res.status(500).json({ error:'주문 조회 오류' });
  }
});

// ══════════════════════════════════════════════════
// GET /api/payment/orders/:id  — 주문 상세
// ══════════════════════════════════════════════════
router.get('/orders/:orderId', requireAuth, async (req, res) => {
  try {
    const { data:order, error } = await supabase
      .from('orders').select('*, order_items(*)')
      .eq('order_number', req.params.orderId)
      .eq('user_id', req.user.sub).single();
    if (error||!order) return res.status(404).json({ error:'주문 없음' });
    res.json({ ok:true, order });
  } catch(err) {
    res.status(500).json({ error:'조회 오류' });
  }
});

// ══════════════════════════════════════════════════
// POST /api/payment/nice-webhook  — 나이스 웹훅 (서버→서버)
// ══════════════════════════════════════════════════
router.post('/nice-webhook', async (req, res) => {
  try {
    const { resultCode, orderId, amount, paymentKey, status } = req.body;
    if (resultCode === '0000' && status === 'paid') {
      await supabase.from('orders').update({
        status:'preparing', payment_status:'paid',
        payment_key:paymentKey, paid_at:new Date().toISOString(),
      }).eq('order_number', orderId);
    }
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ error:'웹훅 처리 오류' });
  }
});

module.exports = router;
