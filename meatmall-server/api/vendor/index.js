const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireVendor } = require('../../middleware/auth');

router.use(requireVendor);

// ════════════════════════════════════════════════════
// GET /api/vendor/me — 내(벤더) 프로필
// ════════════════════════════════════════════════════
router.get('/me', async (req, res) => {
  try {
    const { data: vendor, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('id', req.vendorId)
      .single();
    if (error || !vendor) return res.status(404).json({ error: '거래처 정보를 찾을 수 없습니다' });
    res.json({ ok: true, vendor });
  } catch (err) {
    console.error('[vendor/me]', err);
    res.status(500).json({ error: '프로필 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/vendor/sales/summary — KPI (오늘/이번달 매출, 주문건수)
// ════════════════════════════════════════════════════
router.get('/sales/summary', async (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const y = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
    const monthStart = `${todayStr.slice(0, 7)}-01`;

    const { data: rows, error } = await supabase
      .from('vendor_orders')
      .select('total_amount, status, created_at')
      .eq('vendor_id', req.vendorId)
      .gte('created_at', monthStart);
    if (error) throw error;

    const valid = (rows || []).filter(r => r.status !== 'cancelled');
    const sum = arr => arr.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);

    const todayRows = valid.filter(r => (r.created_at || '').slice(0, 10) === todayStr);
    const yRows     = valid.filter(r => (r.created_at || '').slice(0, 10) === y);

    res.json({
      ok: true,
      summary: {
        today_sales:  sum(todayRows),
        month_sales:  sum(valid),
        today_orders: todayRows.length,
        // 전일 대비
        sales_diff:   sum(todayRows) - sum(yRows),
        orders_diff:  todayRows.length - yRows.length
      }
    });
  } catch (err) {
    console.error('[vendor/sales/summary]', err);
    res.status(500).json({ error: '매출 요약 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/vendor/sales/recent?days=30 — 최근 일자별 매출
// ════════════════════════════════════════════════════
router.get('/sales/recent', async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const { data: rows, error } = await supabase
      .from('vendor_orders')
      .select('total_amount, status, items, created_at')
      .eq('vendor_id', req.vendorId)
      .neq('status', 'cancelled')
      .gte('created_at', from)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const byDate = {};
    (rows || []).forEach(r => {
      const d = (r.created_at || '').slice(0, 10);
      if (!d) return;
      if (!byDate[d]) byDate[d] = { date: d, orders: 0, items: 0, amount: 0 };
      byDate[d].orders += 1;
      byDate[d].amount += Number(r.total_amount) || 0;
      const items = Array.isArray(r.items) ? r.items : [];
      byDate[d].items += items.reduce((s, it) => s + (Number(it.qty || it.quantity) || 0), 0);
    });

    const list = Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));
    res.json({ ok: true, rows: list });
  } catch (err) {
    console.error('[vendor/sales/recent]', err);
    res.status(500).json({ error: '매출 내역 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/vendor/products — 내가 등록한 당일배송 상품
// ════════════════════════════════════════════════════
router.get('/products', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('vendor_id', req.vendorId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, products: (data || []).map(p => ({ ...p, category_name: p.category })) });
  } catch (err) {
    console.error('[vendor/products GET]', err);
    res.status(500).json({ error: '상품 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/vendor/products — 당일배송 상품 등록
// ════════════════════════════════════════════════════
router.post('/products', async (req, res) => {
  try {
    const {
      name, description, category, category_id, source_type, origin,
      weight_g, price, origin_price, stock, min_stock, expiry_days,
      same_day_qty, is_active, emoji, thumbnail_url
    } = req.body;

    if (!name || (!category && !category_id) || price === undefined || price === null || price === '') {
      return res.status(400).json({ error: '상품명, 카테고리, 판매가는 필수입니다' });
    }

    const { data: product, error } = await supabase
      .from('products')
      .insert({
        name,
        description: description || null,
        category: category || null,
        category_id: category_id ? Number(category_id) : null,
        source_type: source_type || 'wholesale',
        origin: origin || null,
        weight_g: Number(weight_g) || 0,
        price: Number(price),
        origin_price: Number(origin_price) || 0,
        stock: Number(stock) || 0,
        min_stock: Number(min_stock) || 10,
        expiry_days: Number(expiry_days) || 0,
        emoji: emoji || '🥩',
        thumbnail_url: thumbnail_url || null,
        is_active: is_active === undefined ? true : !!is_active,
        // 벤더 당일배송 전용
        vendor_id: req.vendorId,
        is_same_day: true,
        same_day_qty: Number(same_day_qty) || 0
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ ok: true, product });
  } catch (err) {
    console.error('[vendor/products POST]', err);
    res.status(500).json({ error: err.message || '상품 등록 오류' });
  }
});

// ════════════════════════════════════════════════════
// PATCH /api/vendor/products/:id — 내 상품 수정 (소유권 확인)
// ════════════════════════════════════════════════════
router.patch('/products/:id', async (req, res) => {
  try {
    const { data: own } = await supabase
      .from('products').select('id, vendor_id').eq('id', req.params.id).single();
    if (!own || String(own.vendor_id) !== String(req.vendorId)) {
      return res.status(403).json({ error: '본인 상품만 수정할 수 있습니다' });
    }

    const allowed = ['name','description','category','category_id','source_type','origin',
      'weight_g','price','origin_price','stock','min_stock','expiry_days',
      'same_day_qty','is_active','emoji','thumbnail_url'];
    const update = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    // 벤더 소유·당일배송 플래그는 고정
    update.vendor_id = req.vendorId;
    update.is_same_day = true;

    const { data: product, error } = await supabase
      .from('products').update(update).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, product });
  } catch (err) {
    console.error('[vendor/products PATCH]', err);
    res.status(500).json({ error: err.message || '상품 수정 오류' });
  }
});

// ════════════════════════════════════════════════════
// DELETE /api/vendor/products/:id — 내 상품 비활성화 (소유권 확인)
// ════════════════════════════════════════════════════
router.delete('/products/:id', async (req, res) => {
  try {
    const { data: own } = await supabase
      .from('products').select('id, vendor_id').eq('id', req.params.id).single();
    if (!own || String(own.vendor_id) !== String(req.vendorId)) {
      return res.status(403).json({ error: '본인 상품만 삭제할 수 있습니다' });
    }
    const { error } = await supabase
      .from('products').update({ is_active: false }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[vendor/products DELETE]', err);
    res.status(500).json({ error: '상품 삭제 오류' });
  }
});

// ════════════════════════════════════════════════════
// GET /api/vendor/orders — 발주현황 (본점 발주 내역)
// ════════════════════════════════════════════════════
const ORDER_STATUSES = ['pending','confirmed','preparing','shipping','delivered','settled','cancelled'];

router.get('/orders', async (req, res) => {
  try {
    const { status, from, to } = req.query;
    let q = supabase
      .from('vendor_orders')
      .select('*')
      .eq('vendor_id', req.vendorId)
      .order('created_at', { ascending: false });

    if (status && ORDER_STATUSES.includes(status)) q = q.eq('status', status);
    if (from) q = q.gte('created_at', from);
    if (to)   q = q.lte('created_at', `${to}T23:59:59`);

    const { data, error } = await q;
    if (error) throw error;

    const rows = (data || []).map(r => {
      const items = Array.isArray(r.items) ? r.items : [];
      const qty = items.reduce((s, it) => s + (Number(it.qty || it.quantity) || 0), 0);
      const firstName = items[0]?.name || items[0]?.product_name || '';
      const itemLabel = firstName
        ? (items.length > 1 ? `${firstName} 외 ${items.length - 1}건` : firstName)
        : `${items.length}개 품목`;
      return {
        id: r.id,
        order_number: r.order_number,
        created_at: r.created_at,
        delivery_date: r.delivery_date || (r.orders?.created_at ? r.orders.created_at.slice(0,10) : null),
        buyer: '정육본가 본점',
        item_label: itemLabel,
        item_count: items.length,
        qty,
        total_amount: r.total_amount,
        status: r.status,
        note: r.note || null
      };
    });

    res.json({ ok: true, orders: rows });
  } catch (err) {
    console.error('[vendor/orders GET]', err);
    res.status(500).json({ error: '발주 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// PATCH /api/vendor/orders/:id/status — 발주 진행상태 변경
// ════════════════════════════════════════════════════
router.patch('/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    // 정산완료(settled)는 관리자 정산에서 처리 → 벤더는 배송완료까지만
    const vendorAllowed = ['confirmed','preparing','shipping','delivered'];
    if (!vendorAllowed.includes(status)) {
      return res.status(400).json({ error: '허용되지 않은 상태입니다' });
    }

    const { data: own } = await supabase
      .from('vendor_orders').select('id, vendor_id').eq('id', req.params.id).single();
    if (!own || String(own.vendor_id) !== String(req.vendorId)) {
      return res.status(403).json({ error: '본인 발주만 변경할 수 있습니다' });
    }

    const { data, error } = await supabase
      .from('vendor_orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, order: data });
  } catch (err) {
    console.error('[vendor/orders PATCH status]', err);
    res.status(500).json({ error: '상태 변경 오류' });
  }
});

// ════════════════════════════════════════════════════
// 재고 이동 요청 (벤더가 직접 필요 재고를 본사에 요청)
// ════════════════════════════════════════════════════
router.post('/transfer-requests', async (req, res) => {
  try {
    const { product_id, item_name, qty, note } = req.body || {};
    if (!(product_id || item_name)) return res.status(400).json({ error: '품목은 필수입니다' });
    const { data, error } = await supabase.from('stock_transfer_requests').insert({
      requester_vendor_id: req.vendorId, product_id: product_id || null, item_name: item_name || null,
      qty: qty != null && qty !== '' ? Number(qty) : null, note: note || null, status: 'open', created_by: 'vendor'
    }).select().single();
    if (error) throw error;
    res.status(201).json({ ok: true, request: data });
  } catch (err) { console.error('[vendor/transfer-requests POST]', err); res.status(500).json({ error: err.message || '요청 오류' }); }
});
router.get('/transfer-requests', async (req, res) => {
  try {
    const { data } = await supabase.from('stock_transfer_requests').select('*')
      .eq('requester_vendor_id', req.vendorId).order('created_at', { ascending: false });
    res.json({ ok: true, requests: data || [] });
  } catch (err) { res.status(500).json({ error: '조회 오류' }); }
});
router.patch('/transfer-requests/:id/cancel', async (req, res) => {
  try {
    const { data: own } = await supabase.from('stock_transfer_requests').select('requester_vendor_id').eq('id', req.params.id).single();
    if (!own || own.requester_vendor_id !== req.vendorId) return res.status(403).json({ error: '권한 없음' });
    await supabase.from('stock_transfer_requests').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '처리 오류' }); }
});

// 정육점간 매출·매입 (매출집계 반영). 출발=매출, 도착=매입.
router.get('/store-transactions', async (req, res) => {
  try {
    const vid = req.vendorId;
    const { data: sales } = await supabase.from('store_transactions').select('*').eq('seller_vendor_id', vid).order('created_at', { ascending: false }).limit(100);
    const { data: purchases } = await supabase.from('store_transactions').select('*').eq('buyer_vendor_id', vid).order('created_at', { ascending: false }).limit(100);
    const sum = arr => (arr || []).reduce((s, r) => s + Number(r.total_amount || 0), 0);
    const vids = [...new Set([...(sales || []).map(s => s.buyer_vendor_id), ...(purchases || []).map(p => p.seller_vendor_id)].filter(Boolean))];
    let vmap = {};
    if (vids.length) { const { data: vs } = await supabase.from('vendors').select('id, vendor_name').in('id', vids); (vs || []).forEach(v => vmap[v.id] = v.vendor_name); }
    res.json({
      ok: true, sales_total: sum(sales), purchase_total: sum(purchases),
      sales: (sales || []).map(s => ({ ...s, counterpart: vmap[s.buyer_vendor_id] || ('매장 ' + s.buyer_vendor_id) })),
      purchases: (purchases || []).map(p => ({ ...p, counterpart: vmap[p.seller_vendor_id] || ('매장 ' + p.seller_vendor_id) }))
    });
  } catch (err) { console.error('[vendor/store-transactions]', err); res.status(500).json({ error: '조회 오류' }); }
});

module.exports = router;
