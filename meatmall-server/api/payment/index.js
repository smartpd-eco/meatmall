const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../../lib/supabase');
const { requireAuth } = require('../../middleware/auth');

// ── 나이스페이먼츠 설정 ──────────────────────────────────
const NICE = {
  clientKey:  process.env.NICE_CLIENT_KEY  || 'test_ck_docs_Jz9BYo1zelvxd10pR0rl',
  secretKey:  process.env.NICE_SECRET_KEY  || 'test_sk_docs_OePez1rFSehN5kNm8dEW',
  baseURL:    'https://api.nicepay.co.kr/v1',
  // 테스트: test_ 접두사 / 운영: 실제 키
};

// Basic 인증 헤더 생성
function niceAuth() {
  const encoded = Buffer.from(`${NICE.secretKey}:`).toString('base64');
  return `Basic ${encoded}`;
}

// ════════════════════════════════════════════════════
// POST /api/payment/ready — 결제 준비 (주문 생성)
// ════════════════════════════════════════════════════
router.post('/ready', requireAuth, async (req, res) => {
  try {
    const {
      items,           // [{ productId, name, price, qty, option }]
      addressId,       // 배송지 ID
      recipient, phone, zipCode, address1, address2, deliveryNote,
      couponId,
      pointUse = 0,
      paymentMethod,   // card | kakao | naver | toss | bank
    } = req.body;

    if (!items || items.length === 0)
      return res.status(400).json({ error: '주문 상품이 없습니다' });

    const userId = req.user.sub;

    // 금액 계산
    const productTotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const deliveryFee  = productTotal >= 50000 ? 0 : 3500;
    const discountAmt  = 0; // 쿠폰 적용 로직 추후 추가
    const finalAmount  = productTotal + deliveryFee - discountAmt - pointUse;

    if (finalAmount < 100)
      return res.status(400).json({ error: '최소 결제 금액은 100원입니다' });

    // 주문번호 생성 (ORD-YYYYMMDD-XXXX)
    const now = new Date();
    const dateStr = now.toISOString().slice(0,10).replace(/-/g,'');
    const orderNumber = `ORD-${dateStr}-${uuidv4().slice(0,6).toUpperCase()}`;

    // 주문 DB 저장 (결제 전 pending 상태)
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        order_number:    orderNumber,
        user_id:         userId,
        status:          'pending',
        recipient:       recipient || '',
        phone:           phone     || '',
        zip_code:        zipCode   || '',
        address1:        address1  || '',
        address2:        address2  || null,
        delivery_note:   deliveryNote || null,
        product_total:   productTotal,
        delivery_fee:    deliveryFee,
        discount_amount: discountAmt,
        point_used:      pointUse,
        final_amount:    finalAmount,
        payment_method:  paymentMethod,
        payment_status:  'unpaid',
      })
      .select('id, order_number')
      .single();

    if (orderErr) throw orderErr;

    // 주문 상품 저장
    const orderItems = items.map(i => ({
      order_id:   order.id,
      product_id: i.productId || null,
      name:       i.name,
      option:     i.option || null,
      price:      i.price,
      qty:        i.qty,
      subtotal:   i.price * i.qty,
    }));
    await supabase.from('order_items').insert(orderItems);

    // 나이스페이먼츠에 전달할 결제 정보 반환
    res.json({
      ok: true,
      order: {
        orderId:      order.order_number,
        orderName:    items.length > 1 ? `${items[0].name} 외 ${items.length-1}건` : items[0].name,
        amount:       finalAmount,
        productTotal, deliveryFee, discountAmt, pointUse,
      },
      nice: {
        clientKey: NICE.clientKey,
      }
    });
  } catch (err) {
    console.error('[payment/ready]', err);
    res.status(500).json({ error: '주문 생성 중 오류가 발생했습니다' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/payment/confirm — 결제 승인 (나이스 서버 검증)
// ════════════════════════════════════════════════════
router.post('/confirm', requireAuth, async (req, res) => {
  try {
    const { paymentKey, orderId, amount } = req.body;

    if (!paymentKey || !orderId || !amount)
      return res.status(400).json({ error: '결제 정보가 올바르지 않습니다' });

    // 1. 주문 금액 검증 (DB와 대조)
    const { data: order } = await supabase
      .from('orders')
      .select('id, final_amount, payment_status, user_id')
      .eq('order_number', orderId)
      .single();

    if (!order)
      return res.status(404).json({ error: '주문을 찾을 수 없습니다' });

    if (order.user_id !== req.user.sub)
      return res.status(403).json({ error: '접근 권한이 없습니다' });

    if (order.payment_status === 'paid')
      return res.status(400).json({ error: '이미 결제된 주문입니다' });

    if (order.final_amount !== Number(amount))
      return res.status(400).json({ error: '결제 금액이 일치하지 않습니다' });

    // 2. 나이스페이먼츠 결제 승인 API 호출
    const niceRes = await fetch(`${NICE.baseURL}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Authorization': niceAuth(),
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) })
    });
    const niceData = await niceRes.json();

    if (!niceRes.ok || niceData.resultCode !== '0000') {
      console.error('[nice confirm fail]', niceData);
      return res.status(400).json({
        error: niceData.resultMsg || '결제 승인에 실패했습니다'
      });
    }

    // 3. DB 결제 완료 처리
    await supabase.from('orders').update({
      status:         'preparing',
      payment_status: 'paid',
      payment_key:    paymentKey,
      paid_at:        new Date().toISOString(),
    }).eq('order_number', orderId);

    // 4. 포인트 적립 (결제금액의 1%)
    const pointEarned = Math.floor(Number(amount) * 0.01);
    if (pointEarned > 0) {
      await supabase.from('point_logs').insert({
        user_id: order.user_id,
        amount:  pointEarned,
        reason:  `주문 ${orderId} 결제 적립`,
        order_id: order.id,
      });
      await supabase.rpc('increment_user_point', {
        p_user_id: order.user_id,
        p_amount:  pointEarned
      }).catch(() => {}); // 함수 없으면 무시
    }

    res.json({
      ok: true,
      message: '결제가 완료됐습니다',
      orderId,
      amount: Number(amount),
      pointEarned,
      paymentKey,
    });

  } catch (err) {
    console.error('[payment/confirm]', err);
    res.status(500).json({ error: '결제 처리 중 오류가 발생했습니다' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/payment/cancel — 결제 취소/환불
// ════════════════════════════════════════════════════
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const { orderId, reason = '고객 요청' } = req.body;

    const { data: order } = await supabase
      .from('orders')
      .select('id, payment_key, payment_status, final_amount, user_id, status')
      .eq('order_number', orderId)
      .single();

    if (!order)
      return res.status(404).json({ error: '주문을 찾을 수 없습니다' });

    if (order.user_id !== req.user.sub)
      return res.status(403).json({ error: '접근 권한이 없습니다' });

    if (order.payment_status !== 'paid')
      return res.status(400).json({ error: '결제된 주문만 취소할 수 있습니다' });

    if (['shipping', 'delivered'].includes(order.status))
      return res.status(400).json({ error: '배송 중이거나 완료된 주문은 취소할 수 없습니다' });

    // 나이스페이먼츠 취소 API
    const niceRes = await fetch(`${NICE.baseURL}/payments/${order.payment_key}/cancel`, {
      method: 'POST',
      headers: {
        'Authorization': niceAuth(),
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        reason,
        cancelAmt: order.final_amount, // 전액 취소
      })
    });
    const niceData = await niceRes.json();

    if (!niceRes.ok || niceData.resultCode !== '0000') {
      return res.status(400).json({
        error: niceData.resultMsg || '취소 처리에 실패했습니다'
      });
    }

    // DB 취소 처리
    await supabase.from('orders').update({
      status:         'cancelled',
      payment_status: 'refunded',
    }).eq('order_number', orderId);

    res.json({ ok: true, message: '주문이 취소됐습니다', orderId });

  } catch (err) {
    console.error('[payment/cancel]', err);
    res.status(500).json({ error: '취소 처리 중 오류가 발생했습니다' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/payment/orders — 내 주문 목록
// ════════════════════════════════════════════════════
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('orders')
      .select('*, order_items(*)', { count: 'exact' })
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);

    const { data: orders, count, error } = await query;
    if (error) throw error;

    res.json({ ok: true, orders, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[payment/orders]', err);
    res.status(500).json({ error: '주문 조회 중 오류가 발생했습니다' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/payment/orders/:orderId — 주문 상세
// ════════════════════════════════════════════════════
router.get('/orders/:orderId', requireAuth, async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('order_number', req.params.orderId)
      .eq('user_id', req.user.sub)
      .single();

    if (error || !order)
      return res.status(404).json({ error: '주문을 찾을 수 없습니다' });

    res.json({ ok: true, order });
  } catch (err) {
    console.error('[payment/orders/:id]', err);
    res.status(500).json({ error: '주문 조회 중 오류가 발생했습니다' });
  }
});

module.exports = router;
