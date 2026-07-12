const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');
const { notifyShippingStart } = require('../notify/index');

// 모든 관리자 라우터에 인증 적용
router.use(requireAdmin);

// ════════════════════════════════════════════════════
// GET /api/admin/dashboard — 대시보드 KPI
// ════════════════════════════════════════════════════
router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const monthStart = today.toISOString().slice(0, 7) + '-01';

    // 오늘 매출
    const { data: todayOrders } = await supabase
      .from('orders')
      .select('final_amount')
      .eq('payment_status', 'paid')
      .gte('paid_at', todayStr);

    // 이번달 매출
    const { data: monthOrders } = await supabase
      .from('orders')
      .select('final_amount')
      .eq('payment_status', 'paid')
      .gte('paid_at', monthStart);

    // 미처리 주문
    const { count: pendingCount } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'preparing')
      .eq('payment_status', 'paid');

    // 활성 구독자
    const { count: subCount } = await supabase
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');

    // 재고 부족 상품
    const { data: lowStock } = await supabase
      .from('products')
      .select('id, name, stock, min_stock, emoji')
      .eq('is_active', true)
      .filter('stock', 'lte', supabase.raw('min_stock'));

    // 미답변 CS
    const { count: pendingCS } = await supabase
      .from('cs_tickets')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');

    const todayRevenue = (todayOrders || []).reduce((s, o) => s + o.final_amount, 0);
    const monthRevenue = (monthOrders || []).reduce((s, o) => s + o.final_amount, 0);

    res.json({
      ok: true,
      kpi: {
        todayRevenue,
        todayOrders:  (todayOrders || []).length,
        monthRevenue,
        pendingOrders: pendingCount || 0,
        activeSubscribers: subCount || 0,
        pendingCS: pendingCS || 0,
      },
      alerts: {
        lowStock: lowStock || [],
        pendingCS: pendingCS || 0,
      }
    });
  } catch (err) {
    console.error('[admin/dashboard]', err);
    res.status(500).json({ error: '대시보드 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/admin/orders — 전체 주문 목록
// ════════════════════════════════════════════════════
router.get('/orders', async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('orders')
      .select('*, users(name, email, phone), order_items(*)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('status', status);
    if (search) query = query.or(`order_number.ilike.%${search}%,recipient.ilike.%${search}%`);

    const { data: orders, count, error } = await query;
    if (error) throw error;

    res.json({ ok: true, orders, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: '주문 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/admin/orders/:id — 주문 상세
// ════════════════════════════════════════════════════
router.get('/orders/:id', async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('*, users(name, email, phone), order_items(*)')
      .eq('id', req.params.id)
      .single();
    if (error || !order) return res.status(404).json({ error: '주문을 찾을 수 없습니다' });
    res.json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ error: '주문 상세 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// PATCH /api/admin/orders/:id — 주문 상태 변경
// ════════════════════════════════════════════════════
router.patch('/orders/:id', async (req, res) => {
  try {
    const { status, tracking_number, carrier } = req.body;
    const update = { status };
    if (tracking_number) update.tracking_number = tracking_number;
    if (carrier)         update.carrier = carrier;
    if (status === 'shipping')   update.shipped_at   = new Date().toISOString();
    if (status === 'delivered')  update.delivered_at = new Date().toISOString();

    const { data: order, error } = await supabase
      .from('orders')
      .update(update)
      .eq('id', req.params.id)
      .select('*, users(name, phone)')
      .single();

    if (error) throw error;

    // 배송 시작 시 소비자 알림톡 발송
    if (status === 'shipping' && order.users?.phone) {
      notifyShippingStart({
        phone:          order.users.phone,
        name:           order.users.name || order.recipient || '고객',
        orderId:        order.order_number,
        carrier:        carrier || order.carrier || 'CJ대한통운',
        trackingNumber: tracking_number || order.tracking_number || '-',
      }).catch(e => console.error('[배송시작 알림 오류]', e));
    }

    res.json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ error: '주문 상태 변경 오류' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/admin/inventory — 재고 현황
// ════════════════════════════════════════════════════
router.get('/inventory', async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('id, name, emoji, category, stock, min_stock, expiry_days, is_active')
      .eq('is_active', true)
      .order('stock', { ascending: true });

    if (error) throw error;

    const inventory = products.map(p => ({
      ...p,
      status: p.stock <= 0 ? 'out' : p.stock <= p.min_stock ? 'low' :
              p.stock <= p.min_stock * 2 ? 'warn' : 'ok',
      pct: Math.min(100, Math.round(p.stock / (p.min_stock * 5) * 100))
    }));

    res.json({ ok: true, inventory });
  } catch (err) {
    res.status(500).json({ error: '재고 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// PATCH /api/admin/inventory/:id — 재고 수량 수정
// ════════════════════════════════════════════════════
router.patch('/inventory/:id', async (req, res) => {
  try {
    const { stock, min_stock } = req.body;
    const update = {};
    if (stock !== undefined)     update.stock     = Number(stock);
    if (min_stock !== undefined) update.min_stock = Number(min_stock);

    const { data, error } = await supabase
      .from('products').update(update).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, product: data });
  } catch (err) {
    res.status(500).json({ error: '재고 수정 오류' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/admin/revenue — 매출/정산
// ════════════════════════════════════════════════════
router.get('/revenue', async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    const days = period === '30d' ? 30 : period === '90d' ? 90 : 7;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data: orders } = await supabase
      .from('orders')
      .select('final_amount, payment_method, created_at, paid_at')
      .eq('payment_status', 'paid')
      .gte('paid_at', from)
      .order('paid_at', { ascending: true });

    // 일별 매출
    const daily = {};
    (orders || []).forEach(o => {
      const date = o.paid_at?.slice(0, 10);
      if (!date) return;
      daily[date] = (daily[date] || 0) + o.final_amount;
    });

    // PG별 매출
    const byMethod = {};
    const feeRates = { CARD: 0.035, KAKAO: 0.035, NAVER: 0.0374, TOSS: 0.033, VBANK: 0, PHONE: 0.045 };
    (orders || []).forEach(o => {
      const m = o.payment_method || 'CARD';
      if (!byMethod[m]) byMethod[m] = { amount: 0, fee: 0 };
      byMethod[m].amount += o.final_amount;
      byMethod[m].fee    += Math.round(o.final_amount * (feeRates[m] || 0.035));
    });

    const totalRevenue = (orders || []).reduce((s, o) => s + o.final_amount, 0);
    const totalFee     = Object.values(byMethod).reduce((s, v) => s + v.fee, 0);

    res.json({ ok: true, totalRevenue, totalFee, netRevenue: totalRevenue - totalFee, daily, byMethod, orderCount: (orders||[]).length });
  } catch (err) {
    res.status(500).json({ error: '매출 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/admin/cs — CS 티켓 목록
// ════════════════════════════════════════════════════
router.get('/cs', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('cs_tickets')
      .select('*, users(name, email, phone)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('status', status);

    const { data: tickets, count, error } = await query;
    if (error) throw error;

    res.json({ ok: true, tickets, total: count });
  } catch (err) {
    res.status(500).json({ error: 'CS 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// PATCH /api/admin/cs/:id — CS 답변 처리
// ════════════════════════════════════════════════════
router.patch('/cs/:id', async (req, res) => {
  try {
    const { answer, status = 'answered' } = req.body;
    if (!answer) return res.status(400).json({ error: '답변 내용을 입력해주세요' });

    const { data: ticket, error } = await supabase
      .from('cs_tickets')
      .update({ answer, status, answered_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*, users(name, phone)')
      .single();

    if (error) throw error;

    // 답변 완료 알림톡 발송
    // notify 모듈에서 처리

    res.json({ ok: true, ticket });
  } catch (err) {
    res.status(500).json({ error: 'CS 답변 오류' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/admin/users — 회원 목록
// ════════════════════════════════════════════════════
// ════════════════════════════════════════════════════
// PATCH /api/admin/users/:id — 회원 등급/활성 상태 변경
// body: { grade?, is_active? }
// ════════════════════════════════════════════════════
router.patch('/users/:id', async (req, res) => {
  try {
    const { grade, is_active } = req.body;
    const GRADES = ['normal', 'bronze', 'silver', 'gold', 'vip'];
    const patch = { updated_at: new Date().toISOString() };
    if (grade !== undefined) {
      if (!GRADES.includes(grade)) return res.status(400).json({ error: '유효하지 않은 등급입니다' });
      patch.grade = grade;
    }
    if (is_active !== undefined) patch.is_active = !!is_active;

    const { data: user, error } = await supabase
      .from('users')
      .update(patch)
      .eq('id', req.params.id)
      .select('id, name, email, phone, grade, point, is_active, is_admin, created_at')
      .single();
    if (error) throw error;
    res.json({ ok: true, user });
  } catch (err) {
    console.error('[admin users PATCH]', err);
    res.status(500).json({ error: '회원 정보 수정 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/admin/users/:id/points — 포인트 가감(+적립/-차감) + 로그 기록
// body: { amount: 정수(±), reason }
// ════════════════════════════════════════════════════
router.post('/users/:id/points', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount, 10);
    const reason = String(req.body.reason || '').trim() || '수동 조정';
    if (!Number.isInteger(amount) || amount === 0)
      return res.status(400).json({ error: '가감할 포인트를 입력해주세요 (0 제외)' });

    const { data: u, error: e1 } = await supabase
      .from('users').select('point').eq('id', req.params.id).single();
    if (e1 || !u) return res.status(404).json({ error: '회원을 찾을 수 없습니다' });

    const current = Number(u.point || 0);
    const next = current + amount;
    if (next < 0) return res.status(400).json({ error: `차감액이 보유 포인트(${current}P)를 초과합니다` });

    const { error: e2 } = await supabase
      .from('users').update({ point: next, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (e2) throw e2;

    await supabase.from('point_logs').insert({
      user_id: req.params.id, amount, reason: `[관리자] ${reason}`.slice(0, 100),
    });

    res.json({ ok: true, point: next, delta: amount });
  } catch (err) {
    console.error('[admin points]', err);
    res.status(500).json({ error: '포인트 조정 오류' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/admin/users — 회원 목록
// ════════════════════════════════════════════════════
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('users')
      .select('id, name, email, phone, grade, point, is_active, is_admin, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);

    const { data: users, count, error } = await query;
    if (error) throw error;

    res.json({ ok: true, users, total: count });
  } catch (err) {
    res.status(500).json({ error: '회원 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// 배송비 정책 설정 (shipping_settings, 단일 행 id=1)
// GET  /api/admin/shipping-settings
// PUT  /api/admin/shipping-settings  { mode: 'free30'|'free50'|'freeall', base_fee }
// ════════════════════════════════════════════════════
router.get('/shipping-settings', async (req, res) => {
  try {
    const { data } = await supabase
      .from('shipping_settings').select('mode, base_fee, updated_at').eq('id', 1).maybeSingle();
    res.json({ ok: true, settings: data || { mode: 'free50', base_fee: 3500 } });
  } catch (err) {
    res.json({ ok: true, settings: { mode: 'free50', base_fee: 3500 } });
  }
});

router.put('/shipping-settings', async (req, res) => {
  try {
    const MODES = ['free30', 'free50', 'freeall'];
    const mode = MODES.includes(req.body.mode) ? req.body.mode : 'free50';
    let base_fee = parseInt(req.body.base_fee, 10);
    if (!Number.isInteger(base_fee) || base_fee < 0) base_fee = 3500;

    const { data, error } = await supabase
      .from('shipping_settings')
      .upsert([{ id: 1, mode, base_fee, updated_at: new Date().toISOString() }], { onConflict: 'id' })
      .select().single();
    if (error) throw error;
    res.json({ ok: true, settings: data });
  } catch (err) {
    console.error('[admin shipping-settings PUT]', err);
    res.status(500).json({ error: '배송비 설정 저장 오류 (shipping_settings 테이블 확인)' });
  }
});

// ════════════════════════════════════════════════════
// 당일배송 정산 (settlement_settings, vendor_settlements)
// ════════════════════════════════════════════════════
router.get('/settlement-settings', async (req, res) => {
  try {
    const { data } = await supabase.from('settlement_settings')
      .select('commission_rate, settle_days').eq('id', 1).maybeSingle();
    res.json({ ok: true, settings: data || { commission_rate: 10, settle_days: 5 } });
  } catch (err) { res.json({ ok: true, settings: { commission_rate: 10, settle_days: 5 } }); }
});

router.put('/settlement-settings', async (req, res) => {
  try {
    let rate = Number(req.body.commission_rate);
    if (isNaN(rate) || rate < 0 || rate > 100) rate = 10;
    let days = parseInt(req.body.settle_days, 10);
    if (!Number.isInteger(days) || days < 1 || days > 30) days = 5;
    const { data, error } = await supabase.from('settlement_settings')
      .upsert([{ id: 1, commission_rate: rate, settle_days: days, updated_at: new Date().toISOString() }], { onConflict: 'id' })
      .select().single();
    if (error) throw error;
    res.json({ ok: true, settings: data });
  } catch (err) {
    console.error('[settlement-settings PUT]', err);
    res.status(500).json({ error: '정산 설정 저장 오류' });
  }
});

// 배송완료된 당일배송 주문을 스캔해 미정산 건의 정산 레코드 생성 (멱등)
router.post('/settlements/generate', async (req, res) => {
  try {
    const { data: st } = await supabase.from('settlement_settings')
      .select('commission_rate, settle_days').eq('id', 1).maybeSingle();
    const rate = Number(st?.commission_rate ?? 10);
    const days = Number(st?.settle_days ?? 5);

    const { data: orders } = await supabase.from('orders')
      .select('id, order_number, final_amount, delivered_at')
      .eq('status', 'delivered').eq('delivery_type', 'same_day');

    const { data: existing } = await supabase.from('vendor_settlements').select('order_id');
    const done = new Set((existing || []).map(x => x.order_id));

    let created = 0;
    for (const o of (orders || [])) {
      if (done.has(o.id)) continue;
      const { data: vo } = await supabase.from('vendor_orders')
        .select('vendor_id, total_amount').eq('order_id', o.id).limit(1).maybeSingle();
      const gross = Number(vo?.total_amount ?? o.final_amount ?? 0);
      const commission = Math.round(gross * rate / 100);
      const base = o.delivered_at ? new Date(o.delivered_at) : new Date();
      const due = new Date(base.getTime() + days * 86400000).toISOString().slice(0, 10);
      const { error } = await supabase.from('vendor_settlements').insert({
        order_id: o.id, vendor_id: vo?.vendor_id || null, order_number: o.order_number,
        gross, commission_rate: rate, commission, payout: gross - commission,
        status: 'pending', due_date: due,
      });
      if (!error) created++;
    }
    res.json({ ok: true, created });
  } catch (err) {
    console.error('[settlements generate]', err);
    res.status(500).json({ error: '정산 집계 오류 (vendor_settlements 테이블 확인)' });
  }
});

router.get('/settlements', async (req, res) => {
  try {
    const { status } = req.query;
    let q = supabase.from('vendor_settlements')
      .select('*, vendors(vendor_name)')
      .order('created_at', { ascending: false }).limit(500);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    const totalPending = (data || []).filter(s => s.status === 'pending').reduce((a, s) => a + Number(s.payout || 0), 0);
    res.json({ ok: true, settlements: data || [], totalPending });
  } catch (err) {
    res.status(500).json({ error: '정산 조회 오류' });
  }
});

router.patch('/settlements/:id/pay', async (req, res) => {
  try {
    const { data, error } = await supabase.from('vendor_settlements')
      .update({ status: 'paid', settled_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, settlement: data });
  } catch (err) {
    res.status(500).json({ error: '정산 완료 처리 오류' });
  }
});

// ════════════════════════════════════════════════════
// 무통장 입금 계좌 (vbank_settings, 사업주 직접 변경)
// ════════════════════════════════════════════════════
router.get('/vbank-settings', async (req, res) => {
  try {
    const { data } = await supabase.from('vbank_settings').select('bank, account, holder').eq('id', 1).maybeSingle();
    res.json({ ok: true, settings: data || { bank: '기업은행', account: '', holder: '(주)정육본가' } });
  } catch (err) { res.json({ ok: true, settings: { bank: '기업은행', account: '', holder: '(주)정육본가' } }); }
});

router.put('/vbank-settings', async (req, res) => {
  try {
    const bank = String(req.body.bank || '').trim();
    const account = String(req.body.account || '').trim();
    const holder = String(req.body.holder || '').trim();
    if (!bank || !account || !holder) return res.status(400).json({ error: '은행·계좌번호·예금주를 모두 입력해주세요' });
    const { data, error } = await supabase.from('vbank_settings')
      .upsert([{ id: 1, bank, account, holder, updated_at: new Date().toISOString() }], { onConflict: 'id' })
      .select().single();
    if (error) throw error;
    res.json({ ok: true, settings: data });
  } catch (err) {
    console.error('[vbank-settings PUT]', err);
    res.status(500).json({ error: '무통장 계좌 저장 오류' });
  }
});

module.exports = router;
