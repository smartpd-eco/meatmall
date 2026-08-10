const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../../lib/supabase');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { notifyOrderComplete, notifyAdminNewOrder, notifyAdmins } = require('../notify/index');

// ══════════════════════════════════════════════════
// 나이스페이먼츠 설정 — 키값만 Vercel 환경변수에 등록하면 됨
// ══════════════════════════════════════════════════
// 토스페이먼츠(TossPayments) — 환경변수 미설정 시 공개 문서 테스트 키로 폴백(테스트 전용)
// ⚠️ 라이브 전환 시 Vercel 환경변수에 실키 등록. 실 시크릿 키는 절대 코드에 넣지 말 것.
const TOSS = {
  clientKey: process.env.TOSS_CLIENT_KEY || 'test_ck_D5GePWvyJnrK0W0k6q8gLzN97Eoq',
  secretKey: process.env.TOSS_SECRET_KEY || 'test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R',
  baseURL:   'https://api.tosspayments.com/v1',
};
TOSS.isTest = /^test_/.test(TOSS.secretKey);

// 무통장 계좌 정보 — 환경변수로 관리
const VBANK = {
  bank:    process.env.VBANK_BANK    || '기업은행',
  account: process.env.VBANK_ACCOUNT || '123-456789-01-001',
  holder:  process.env.VBANK_HOLDER  || '(주)정육본가',
};

function tossAuth() {
  // Basic base64(SECRET_KEY:) — 콜론 필수
  return 'Basic ' + Buffer.from(`${TOSS.secretKey}:`).toString('base64');
}
function makeOrderNo() {
  const d = new Date().toISOString().slice(0,10).replace(/-/g,'');
  return `ORD-${d}-${uuidv4().slice(0,6).toUpperCase()}`;
}

// ── 배송비 정책 (shipping_settings 테이블, 60초 캐시, 테이블 없거나 오류 시 기본값 폴백)
let _shipCache = null, _shipAt = 0;
async function getShipping() {
  if (_shipCache && Date.now() - _shipAt < 60000) return _shipCache;
  let s = { mode: 'free50', base_fee: 3500 };
  try {
    const { data } = await supabase.from('shipping_settings').select('mode, base_fee').eq('id', 1).maybeSingle();
    if (data) s = { mode: data.mode || 'free50', base_fee: Number(data.base_fee ?? 3500) };
  } catch (e) { /* 테이블 미생성 등 → 기본값 사용 */ }
  _shipCache = s; _shipAt = Date.now();
  return s;
}
// 무료 기준 금액(0 = 전상품 무료)
function shipThreshold(mode) { return mode === 'free30' ? 30000 : mode === 'free50' ? 50000 : 0; }
// 실제 부과 배송비 계산
function shipFee(s, productTotal) {
  if (s.mode === 'freeall') return 0;
  return productTotal >= shipThreshold(s.mode) ? 0 : Number(s.base_fee || 0);
}

// ── 무통장 계좌 (vbank_settings 테이블, 60초 캐시, 미설정 시 VBANK 기본값)
let _vbCache = null, _vbAt = 0;
async function getVbank() {
  if (_vbCache && Date.now() - _vbAt < 60000) return _vbCache;
  let v = { bank: VBANK.bank, account: VBANK.account, holder: VBANK.holder };
  try {
    const { data } = await supabase.from('vbank_settings').select('bank,account,holder').eq('id', 1).maybeSingle();
    if (data) v = { bank: data.bank || v.bank, account: data.account || v.account, holder: data.holder || v.holder };
  } catch (e) {}
  _vbCache = v; _vbAt = Date.now();
  return v;
}

// ══════════════════════════════════════════════════
// GET /api/payment/config  — 프론트에 결제 설정 전달
// ══════════════════════════════════════════════════
router.get('/config', async (req, res) => {
  const s = await getShipping();
  res.json({
    ok: true,
    clientKey: TOSS.clientKey,
    isTest: TOSS.isTest,
    vbank: await getVbank(),
    methods: ['CARD','KAKAO','NAVER','TOSS','VBANK','PHONE'],
    shippingMode: s.mode,
    freeAll: s.mode === 'freeall',
    freeShipping: shipThreshold(s.mode),
    deliveryFee: s.base_fee,
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
      paymentMethod='CARD', depositorName, bankName,
      deliveryType='standard'
    } = req.body;
    const deliveryTypeV = deliveryType === 'same_day' ? 'same_day' : 'standard';

    if (!items?.length) return res.status(400).json({ error:'주문 상품이 없습니다' });
    if (!recipient || !phone || !zipCode || !address1)
      return res.status(400).json({ error:'배송지 정보를 입력해주세요' });

    const userId = req.user.sub;

    // 계정에 전화번호가 없으면, 배송지에 입력한 번호를 계정에 자동 등록(별도 인증 단계 불필요).
    // 배송지 저장 시 이미 번호를 받으므로 주문을 막지 않고 진행한다.
    try {
      const { data: acctUser } = await supabase.from('users').select('phone').eq('id', userId).single();
      if (!acctUser?.phone && phone) {
        // 다른 계정이 이미 쓰는 번호면 자동등록 생략(중복 방지) — 주문 자체는 배송지 번호로 진행
        const { data: dupe } = await supabase.from('users').select('id').eq('phone', phone).neq('id', userId).limit(1);
        if (!dupe || !dupe.length) {
          await supabase.from('users').update({ phone, updated_at: new Date().toISOString() }).eq('id', userId);
        }
      }
    } catch (e) { console.error('[ready 계정 전화번호 자동등록 오류]', e.message); }

    const productTotal = items.reduce((s,i) => s + i.price * i.qty, 0);
    const deliveryFee  = shipFee(await getShipping(), productTotal);
    const vb           = await getVbank();
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
      delivery_type:   deliveryTypeV,
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
        orderData.bank_name        = bankName || vb.bank;
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

    // 무통장 주문은 접수 즉시 관리자 알림 (카드는 confirm에서 발송)
    if (isVbank) {
      notifyAdmins({
        orderNo:      orderNumber,
        customerName: recipient || '고객',
        amount:       finalAmount,
        address:      address1 || '',
      }).catch(e => console.error('[관리자 알림 오류(무통장)]', e));
    }

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
            bank:     bankName || vb.bank,
            account:  vb.account,
            holder:   vb.holder,
            deadline: new Date(Date.now()+3*86400000).toLocaleDateString('ko-KR'),
            amount:   finalAmount,
          }
        })
      },
      toss: { clientKey: TOSS.clientKey, isTest: TOSS.isTest },
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
      .from('orders').select('id,final_amount,payment_status,user_id,phone,recipient,payment_method,address1')
      .eq('order_number', orderId).single();

    if (!order)            return res.status(404).json({ error:'주문을 찾을 수 없습니다' });
    if (order.user_id !== req.user.sub) return res.status(403).json({ error:'접근 권한 없음' });
    if (order.payment_status === 'paid') return res.status(400).json({ error:'이미 결제된 주문' });
    if (order.final_amount !== Number(amount)) return res.status(400).json({ error:'결제 금액 불일치' });

    // 토스페이먼츠 결제 승인 (테스트 키도 실제 승인 API 호출). 금액은 위에서 서버 저장값과 검증 완료.
    if (TOSS.secretKey) {
      const tr = await fetch(`${TOSS.baseURL}/payments/confirm`, {
        method:'POST',
        headers:{ Authorization: tossAuth(), 'Content-Type':'application/json' },
        body: JSON.stringify({ paymentKey, orderId, amount:Number(amount) })
      });
      const td = await tr.json();
      if (!tr.ok) {
        console.error('[payment/confirm:toss]', {
          orderId,
          amount: Number(amount),
          status: tr.status,
          code: td.code,
          message: td.message,
        });
        return res.status(400).json({ error: td.message||'결제 승인 실패', code: td.code });
      }
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
    notifyAdmins({
      orderNo:      orderId,
      customerName: order.recipient || '고객',
      amount:       order.final_amount,
      address:      order.address1 || '',
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

    // 토스페이먼츠 결제 취소 API
    if (TOSS.secretKey && order.payment_key) {
      const tr = await fetch(`${TOSS.baseURL}/payments/${order.payment_key}/cancel`, {
        method:'POST',
        headers:{ Authorization: tossAuth(), 'Content-Type':'application/json' },
        body: JSON.stringify({ cancelReason: reason, ...(cancelAmt ? { cancelAmount: Number(cancelAmt) } : {}) })
      });
      const td = await tr.json();
      if (!tr.ok) return res.status(400).json({ error: td.message||'취소 실패' });
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

    if (TOSS.secretKey && order.payment_key) {
      const tr = await fetch(`${TOSS.baseURL}/payments/${order.payment_key}/cancel`, {
        method:'POST',
        headers:{ Authorization: tossAuth(), 'Content-Type':'application/json' },
        body: JSON.stringify({ cancelReason: reason, cancelAmount: Number(cancelAmt) })
      });
      const td = await tr.json();
      if (!tr.ok) return res.status(400).json({ error: td.message||'부분 취소 실패' });
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
// POST /api/payment/toss-webhook  — 토스페이먼츠 웹훅 (서버→서버)
// PAYMENT_STATUS_CHANGED 등. 카드 확정은 successUrl→/confirm에서 완료됨(보조 안전망).
// ══════════════════════════════════════════════════
router.post('/toss-webhook', async (req, res) => {
  try {
    const { eventType, data } = req.body || {};
    if (eventType === 'PAYMENT_STATUS_CHANGED' && data && data.orderId) {
      if (data.status === 'DONE') {
        await supabase.from('orders').update({
          status:'preparing', payment_status:'paid',
          payment_key:data.paymentKey, paid_at:new Date().toISOString(),
        }).eq('order_number', data.orderId).eq('payment_status', 'unpaid');
      } else if (['CANCELED','PARTIAL_CANCELED','EXPIRED','ABORTED'].includes(data.status)) {
        await supabase.from('orders').update({
          payment_status: data.status === 'CANCELED' ? 'refunded' : 'cancelled',
        }).eq('order_number', data.orderId);
      }
    }
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ error:'웹훅 처리 오류' });
  }
});

module.exports = router;
