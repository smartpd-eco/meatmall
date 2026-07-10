const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');
const { findBestVendor } = require('../../lib/auto-assign');

router.use(requireAdmin);

// GET /api/admin/assignments
router.get('/', async (req, res) => {
  try {
    const { date, status, page = 1, limit = 30 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('order_assignments')
      .select(
        '*, orders(order_number, total_amount, status, created_at, recipient, address), vendors(vendor_name)',
        { count: 'exact' }
      )
      .order('assigned_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('assignment_status', status);
    if (date) {
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      query = query.gte('assigned_at', date).lt('assigned_at', next.toISOString().slice(0, 10));
    }

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ ok: true, assignments: data || [], total: count });
  } catch (err) {
    console.error('[assignments GET]', err);
    res.status(500).json({ error: '배정 목록 조회 오류' });
  }
});

// GET /api/admin/assignments/stats — /:id 보다 먼저 등록
router.get('/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const { data: all } = await supabase
      .from('order_assignments')
      .select('*, vendors(vendor_name)')
      .gte('assigned_at', today);

    const rows = all || [];
    const stats = {
      total:     rows.length,
      auto:      rows.filter(a => a.assigned_by === 'auto').length,
      manual:    rows.filter(a => a.assigned_by === 'manual').length,
      accepted:  rows.filter(a => a.assignment_status === 'accepted').length,
      completed: rows.filter(a => a.assignment_status === 'completed').length,
      rejected:  rows.filter(a => a.assignment_status === 'rejected').length,
    };

    const vendorStats = {};
    rows.forEach(a => {
      const name = a.vendors?.vendor_name || `거래처${a.vendor_id}`;
      if (!vendorStats[name]) vendorStats[name] = { total: 0, completed: 0, in_progress: 0, rejected: 0 };
      vendorStats[name].total++;
      if (a.assignment_status === 'completed') vendorStats[name].completed++;
      else if (a.assignment_status === 'rejected') vendorStats[name].rejected++;
      else vendorStats[name].in_progress++;
    });

    res.json({ ok: true, stats, vendor_stats: vendorStats });
  } catch (err) {
    console.error('[assignments/stats GET]', err);
    res.status(500).json({ error: '배정 통계 조회 오류' });
  }
});

// POST /api/admin/assignments/auto
router.post('/auto', async (req, res) => {
  try {
    const { data: pendingOrders, error: ordErr } = await supabase
      .from('orders')
      .select('id, order_number, address1, final_amount, delivery_type, order_items(product_id, qty, price)')
      .eq('status', 'pending')
      .eq('payment_status', 'paid')
      .eq('delivery_type', 'same_day');   // 당일배송 주문만 정육점 배정 대상
    if (ordErr) throw ordErr;

    if (!pendingOrders?.length) {
      return res.json({ ok: true, assigned: 0, failed: 0, details: [], message: '배정 대기 주문이 없습니다' });
    }

    let assigned = 0;
    let failed = 0;
    const details = [];

    for (const order of pendingOrders) {
      try {
        const dong = parseDong(order.address1 || '');

        const { data: zone } = await supabase
          .from('delivery_zones')
          .select('*')
          .eq('dong', dong)
          .eq('is_active', true)
          .single();

        if (!zone) {
          details.push({ order_id: order.id, order_number: order.order_number, status: 'failed', reason: `권역 미설정: ${dong}` });
          failed++;
          continue;
        }

        const totalQty = (order.order_items || []).reduce((s, i) => s + (i.qty || 0), 0);
        const firstProductId = order.order_items?.[0]?.product_id;

        const best = await findBestVendor(supabase, zone.id, totalQty, firstProductId);
        if (!best) {
          details.push({ order_id: order.id, order_number: order.order_number, status: 'failed', reason: '적합 거래처 없음 (재고/혼잡도 부족)' });
          failed++;
          continue;
        }

        const { error: aErr } = await supabase
          .from('order_assignments')
          .insert({
            order_id: order.id,
            vendor_id: best.vendor_id,
            zone_id: zone.id,
            assignment_status: 'pending',
            score: best.total_score,
            score_breakdown: best.breakdown,
            assigned_by: 'auto'
          });
        if (aErr) throw aErr;

        await supabase.from('orders').update({ status: 'preparing' }).eq('id', order.id);

        const orderNumber = `VO-${order.id.slice(0, 8).toUpperCase()}`;
        await supabase.from('vendor_orders').insert({
          order_id: order.id,
          vendor_id: best.vendor_id,
          order_number: orderNumber,
          total_amount: order.final_amount || 0,
          status: 'pending',
          items: order.order_items || []
        });

        details.push({
          order_id: order.id,
          order_number: order.order_number,
          status: 'assigned',
          vendor_id: best.vendor_id,
          vendor_name: best.vendor_name,
          score: best.total_score
        });
        assigned++;
      } catch (innerErr) {
        console.error('[auto-assign inner]', innerErr);
        details.push({ order_id: order.id, order_number: order.order_number, status: 'failed', reason: '처리 오류' });
        failed++;
      }
    }

    res.json({ ok: true, assigned, failed, details });
  } catch (err) {
    console.error('[assignments/auto POST]', err);
    res.status(500).json({ error: '자동 배정 오류' });
  }
});

// PUT /api/admin/assignments/:id/accept
router.put('/:id/accept', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('order_assignments')
      .update({ assignment_status: 'accepted', accepted_at: new Date().toISOString(), assigned_by: 'manual' })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, assignment: data });
  } catch (err) {
    console.error('[assignments PUT/:id/accept]', err);
    res.status(500).json({ error: '배정 수락 오류' });
  }
});

// PUT /api/admin/assignments/:id/reject
router.put('/:id/reject', async (req, res) => {
  try {
    const { reject_reason } = req.body;

    const { data: current, error } = await supabase
      .from('order_assignments')
      .update({ assignment_status: 'rejected', reject_reason })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;

    // 차순위 거래처 자동 재배정 시도
    let reAssigned = null;
    if (current.zone_id) {
      const { data: order } = await supabase
        .from('orders')
        .select('order_items(product_id, quantity)')
        .eq('id', current.order_id)
        .single();

      const totalQty = (order?.order_items || []).reduce((s, i) => s + i.quantity, 0);
      const firstProductId = order?.order_items?.[0]?.product_id;

      const best = await findBestVendor(supabase, current.zone_id, totalQty, firstProductId);
      if (best && best.vendor_id !== current.vendor_id) {
        const { data: newAssign } = await supabase
          .from('order_assignments')
          .insert({
            order_id: current.order_id,
            vendor_id: best.vendor_id,
            zone_id: current.zone_id,
            assignment_status: 'pending',
            score: best.total_score,
            score_breakdown: best.breakdown,
            assigned_by: 'auto'
          })
          .select()
          .single();
        reAssigned = newAssign;
      }
    }

    res.json({ ok: true, rejected: current, re_assigned: reAssigned });
  } catch (err) {
    console.error('[assignments PUT/:id/reject]', err);
    res.status(500).json({ error: '배정 거절 오류' });
  }
});

function parseDong(address) {
  const match = address.match(/(\S+동)/);
  return match ? match[1] : '';
}

module.exports = router;
