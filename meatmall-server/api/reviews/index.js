const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAuth } = require('../../middleware/auth');

function maskName(name) {
  const value = String(name || '구매고객').trim();
  if (value.length <= 1) return value;
  if (value.length === 2) return value[0] + '*';
  return value[0] + '*'.repeat(Math.min(2, value.length - 2)) + value[value.length - 1];
}

// GET /api/reviews/product/:productId — 공개 상품 리뷰
router.get('/product/:productId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('product_reviews')
      .select('id, product_id, rating, content, created_at, updated_at, users(name)')
      .eq('product_id', req.params.productId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    const reviews = (data || []).map(row => ({
      id: row.id,
      rating: Number(row.rating),
      content: row.content,
      created_at: row.created_at,
      updated_at: row.updated_at,
      reviewer_name: maskName(row.users?.name),
      verified_purchase: true,
    }));
    const count = reviews.length;
    const average = count
      ? Math.round((reviews.reduce((sum, row) => sum + row.rating, 0) / count) * 10) / 10
      : 0;
    const distribution = [5, 4, 3, 2, 1].map(rating => ({
      rating,
      count: reviews.filter(row => row.rating === rating).length,
    }));
    res.json({ ok: true, reviews, summary: { count, average, distribution } });
  } catch (err) {
    console.error('[reviews/get]', err);
    res.status(500).json({ error: '리뷰를 불러오지 못했습니다' });
  }
});

// POST /api/reviews — 배송 완료된 구매 상품 리뷰 등록/수정
router.post('/', requireAuth, async (req, res) => {
  try {
    const { productId, orderId } = req.body || {};
    const rating = Number(req.body?.rating);
    const content = String(req.body?.content || '').trim();
    if (!productId || !orderId) return res.status(400).json({ error: '상품과 주문 정보가 필요합니다' });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5)
      return res.status(400).json({ error: '별점은 1점부터 5점까지 선택해주세요' });
    if (content.length < 10 || content.length > 1000)
      return res.status(400).json({ error: '리뷰는 10자 이상 1,000자 이하로 작성해주세요' });

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, status, order_items(product_id)')
      .eq('id', orderId)
      .eq('user_id', req.user.sub)
      .single();
    if (orderError || !order) return res.status(404).json({ error: '주문을 찾을 수 없습니다' });
    if (order.status !== 'delivered') return res.status(400).json({ error: '배송 완료된 상품만 리뷰를 작성할 수 있습니다' });
    if (!(order.order_items || []).some(item => String(item.product_id) === String(productId)))
      return res.status(400).json({ error: '해당 주문에서 구매한 상품이 아닙니다' });

    const { data: review, error } = await supabase
      .from('product_reviews')
      .upsert({
        product_id: productId,
        user_id: req.user.sub,
        order_id: orderId,
        rating,
        content,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,order_id,product_id' })
      .select('id, product_id, rating, content, created_at, updated_at')
      .single();
    if (error) throw error;
    res.status(201).json({ ok: true, review });
  } catch (err) {
    console.error('[reviews/post]', err);
    res.status(500).json({ error: '리뷰를 저장하지 못했습니다' });
  }
});

module.exports = router;

