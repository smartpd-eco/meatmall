const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../../lib/supabase');
const { requireAuth, requireAdmin } = require('../../middleware/auth');

const NICE = {
  clientKey: process.env.NICE_CLIENT_KEY || 'test_ck_docs_Jz9BYo1zelvxd10pR0rl',
  secretKey: process.env.NICE_SECRET_KEY || 'test_sk_docs_OePez1rFSehN5kNm8dEW',
  baseURL:   'https://api.nicepay.co.kr/v1',
};
function niceAuth(){
  return 'Basic ' + Buffer.from(`${NICE.secretKey}:`).toString('base64');
}

// 주문번호 생성
function makeOrderNo(){
  const d = new Date();
  const ds = d.toISOString().slice(0,10).replace(/-/g,'');
  return `ORD-${ds}-${uuidv4().slice(0,6).toUpperCase()}`;
}

// ════════════════════════════════════════════
// POST /api/payment/ready  —  주문 생성
// ════════════════════════════════════════════
router.post('/ready', requireAuth, async (req, res) => {
  try {
    const { items, recipient, phone, zipCode, address1, address2,
            deliveryNote, pointUse=0, paymentMethod='CARD',
            bankName, depositorName } = req.body;

    if (!items || !items.length)
      return res.status(400).json({ error:'주문 상품이 없습니다' });

    const userId       = req.user.sub;
    const productTotal = items.reduce((s,i) => s + i.price*i.qty, 0);
    const deliveryFee  = productTotal >= 50000 ? 0 : 3500;
    const finalAmount  = productTotal + deliveryFee - Number(pointUse);

    if (finalAmount < 100)
      return res.status(400).json({ error:'최소 결제금액은 100원입니다' });

    const orderNumber = makeOrderNo();

    // 무통장이면 입금대기 상태
    const isVbank   = paymentMethod === 'VBANK';
    const payStatus = isVbank ? 'awaiting_deposit' : 'unpaid';
    const ordStatus = isVbank ? 'pending_deposit'  : 'pending';

    const { data: order, error } = await supabase
      .from('orders')
      .insert({
        order_number:    orderNumber,
        user_id:         userId,
        status:          ordStatus,
        recipient:       recipient||'',
        phone:           phone||'',
        zip_code:        zipCode||'',
        address1:        address1||'',
        address2:        address2||null,
        delivery_note:   deliveryNote||null,
        product_total:   productTotal,
        delivery_fee:    deliveryFee,
        discount_amount: 0,
        point_used:      Number(pointUse),
        final_amount:    finalAmount,
        payment_method:  paymentMethod,
        payment_status:  payStatus,
        // 무통장 전용 필드
        bank_name:       bankName||null,
        depositor_name:  depositorName||null,
        deposit_deadline: isVbank
          ? new Date(Date.now() + 3*24*60*60*1000).toISOString() // 3일 후
          : null,
      })
      .select('id, order_number')
      .single();

    if (error) throw error;

    // 주문 상품 저장
    await supabase.from('order_items').insert(
      items.map(i => ({
        order_id:   order.id,
        product_id: i.productId||null,
        name:       i.name,
        option:     i.option||null,
        price:      i.price,
        qty:        i.qty,
        subtotal:   i.price*i.qty,
      }))
    );

    res.json({
      ok: true,
      order: {
        orderId:      order.order_number,
        orderName:    items.length>1 ? `${items[0].name} 외 ${items.length-1}건` : items[0].name,
        amount:       finalAmount,
        productTotal, deliveryFee,
        paymentMethod,
        isVbank,
        // 무통장 안내 정보
        ...(isVbank && {
          bankInfo: {
            bank:     bankName || '기업은행',
            account:  '123-456789-01-001',
            holder:   '(주)정육본가',
            deadline: new Date(Date.now() + 3*24*60*60*1000).toLocaleDateString('ko-KR'),
            amount:   finalAmount,
          }
        }),
      },
      nice: { clientKey: NICE.clientKey },
    });
  } catch(err) {
    console.error('[payment/ready]', err);
    res.status(500).json({ error:'주문 생성 오류' });
  }
});

// ════════════════════════════════════════════
// POST /api/payment/confirm  —  카드/간편결제 승인
// ════════════════════════════════════════════
router.post('/confirm', requireAuth, async (req, res) => {
  try {
    const { paymentKey, orderId, amount } = req.body;
    if (!paymentKey || !orderId || !amount)
      return res.status(400).json({ error:'결제 정보가 올바르지 않습니다' });

    const { data: order } = await supabase
      .from('orders').select('id, final_amount, payment_status, user_id')
      .eq('order_number', orderId).single();

    if (!order) return res.status(404).json({ error:'주문 없음' });
    if (order.user_id !== req.user.sub) return res.status(403).json({ error:'권한 없음' });
    if (order.payment_status === 'paid') return res.status(400).json({ error:'이미 결제됨' });
    if (order.final_amount !== Number(amount)) return res.status(400).json({ error:'금액 불일치' });

    // 나이스 승인
    const niceRes = await fetch(`${NICE.baseURL}/payments/confirm`, {
      method:'POST',
      headers:{ Authorization:niceAuth(), 'Content-Type':'application/json' },
      body: JSON.stringify({ paymentKey, orderId, amount:Number(amount) })
    });
    const niceData = await niceRes.json();
    if (!niceRes.ok || niceData.resultCode !== '0000')
      return res.status(400).json({ error: niceData.resultMsg||'결제 승인 실패' });

    await supabase.from('orders').update({
      status:'preparing', payment_status:'paid',
      payment_key:paymentKey, paid_at:new Date().toISOString(),
    }).eq('order_number', orderId);

    // 포인트 1% 적립
    const pt = Math.floor(Number(amount)*0.01);
    if (pt > 0) {
      await supabase.from('point_logs').insert({
        user_id:order.user_id, amount:pt,
        reason:`주문 ${orderId} 결제 적립`, order_id:order.id,
      });
    }

    res.json({ ok:true, message:'결제 완료', orderId, amount:Number(amount), pointEarned:pt });
  } catch(err) {
    console.error('[payment/confirm]', err);
    res.status(500).json({ error:'결제 처리 오류' });
  }
});

// ════════════════════════════════════════════
// POST /api/payment/vbank-confirm  —  관리자 무통장 입금 확인
// ════════════════════════════════════════════
router.post('/vbank-confirm', requireAdmin, async (req, res) => {
  try {
    const { orderId, depositorName, depositAmount } = req.body;
    if (!orderId) return res.status(400).json({ error:'주문번호 필요' });

    const { data: order } = await supabase
      .from('orders').select('id, final_amount, payment_status, user_id, order_number')
      .eq('order_number', orderId).single();

    if (!order) return res.status(404).json({ error:'주문 없음' });
    if (order.payment_status === 'paid') return res.status(400).json({ error:'이미 입금 확인됨' });

    // 금액 확인
    if (depositAmount && Number(depositAmount) !== order.final_amount)
      return res.status(400).json({ error:`금액 불일치 (주문: ${order.final_amount}원, 입금: ${depositAmount}원)` });

    await supabase.from('orders').update({
      status:          'preparing',
      payment_status:  'paid',
      depositor_name:  depositorName || null,
      paid_at:         new Date().toISOString(),
    }).eq('order_number', orderId);

    // 포인트 적립
    const pt = Math.floor(order.final_amount * 0.01);
    if (pt > 0) {
      await supabase.from('point_logs').insert({
        user_id: order.user_id, amount: pt,
        reason: `주문 ${orderId} 무통장 입금 적립`, order_id: order.id,
      });
    }

    res.json({ ok:true, message:'입금 확인 완료. 주문이 준비중으로 변경됐습니다.', orderId, pointEarned:pt });
  } catch(err) {
    console.error('[vbank-confirm]', err);
    res.status(500).json({ error:'입금 확인 처리 오류' });
  }
});

// ════════════════════════════════════════════
// POST /api/payment/cancel  —  주문 취소/환불
// ════════════════════════════════════════════
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const { orderId, reason='고객 요청' } = req.body;
    const { data: order } = await supabase
      .from('orders').select('id, payment_key, payment_status, final_amount, user_id, status, payment_method')
      .eq('order_number', orderId).single();

    if (!order) return res.status(404).json({ error:'주문 없음' });
    if (order.user_id !== req.user.sub) return res.status(403).json({ error:'권한 없음' });
    if (['shipping','delivered'].includes(order.status))
      return res.status(400).json({ error:'배송 중이거나 완료된 주문은 취소 불가' });

    // 무통장 입금대기 → 그냥 취소
    if (order.payment_method === 'VBANK' && order.payment_status === 'awaiting_deposit') {
      await supabase.from('orders').update({
        status:'cancelled', payment_status:'cancelled'
      }).eq('order_number', orderId);
      return res.json({ ok:true, message:'주문이 취소됐습니다', orderId });
    }

    if (order.payment_status !== 'paid')
      return res.status(400).json({ error:'결제된 주문만 취소 가능' });

    // 나이스 취소
    const niceRes = await fetch(`${NICE.baseURL}/payments/${order.payment_key}/cancel`, {
      method:'POST',
      headers:{ Authorization:niceAuth(), 'Content-Type':'application/json' },
      body: JSON.stringify({ reason, cancelAmt:order.final_amount })
    });
    const niceData = await niceRes.json();
    if (!niceRes.ok || niceData.resultCode !== '0000')
      return res.status(400).json({ error: niceData.resultMsg||'취소 실패' });

    await supabase.from('orders').update({
      status:'cancelled', payment_status:'refunded'
    }).eq('order_number', orderId);

    res.json({ ok:true, message:'주문이 취소됐습니다', orderId });
  } catch(err) {
    console.error('[payment/cancel]', err);
    res.status(500).json({ error:'취소 처리 오류' });
  }
});

// ════════════════════════════════════════════
// GET /api/payment/orders  —  내 주문 목록
// ════════════════════════════════════════════
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const { status, page=1, limit=10 } = req.query;
    const offset = (page-1)*limit;
    let query = supabase
      .from('orders').select('*, order_items(*)', { count:'exact' })
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending:false })
      .range(offset, offset+Number(limit)-1);
    if (status) query = query.eq('status', status);
    const { data:orders, count, error } = await query;
    if (error) throw error;
    res.json({ ok:true, orders, total:count, page:Number(page) });
  } catch(err) {
    res.status(500).json({ error:'주문 조회 오류' });
  }
});

// ════════════════════════════════════════════
// GET /api/payment/orders/:orderId  —  주문 상세
// ════════════════════════════════════════════
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

module.exports = router;
