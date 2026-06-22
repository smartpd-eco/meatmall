const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');
const { optionalAuth } = require('../../middleware/auth');

// ════════════════════════════════════════════════════
// CORS 설정 - GitHub Pages → Vercel API 호출 허용
// ════════════════════════════════════════════════════
const allowedOrigins = [
  'https://smartpd-eco.github.io',
  'https://meatmall.vercel.app',
];

router.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// ════════════════════════════════════════════════════
// GET /api/products — 상품 목록
// ════════════════════════════════════════════════════
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      category, sort = 'created_at', order = 'desc',
      page = 1, limit = 20, search, is_subscribe
    } = req.query;

    let query = supabase
      .from('products')
      .select('*', { count: 'exact' })
      .eq('is_active', true)
      .range((page-1)*limit, page*limit - 1);

    if (category)     query = query.eq('category', category);
    if (is_subscribe) query = query.eq('is_subscribe', true);
    if (search)       query = query.ilike('name', `%${search}%`);

    if (sort === 'price_asc') query = query.order('price', { ascending: true });
    else if (sort === 'price_desc') query = query.order('price', { ascending: false });
    else query = query.order(sort, { ascending: order === 'asc' });

    const { data: products, count, error } = await query;
    if (error) throw error;

    res.json({ ok: true, products, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[products]', err);
    res.status(500).json({ error: '상품 조회 중 오류가 발생했습니다' });
  }
});

router.get('/best', async (req, res) => {
  try {
    const { data: products } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(8);

    res.json({ ok: true, products: products || [] });
  } catch (err) {
    res.status(500).json({ error: '조회 오류' });
  }
});

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', req.params.id)
      .eq('is_active', true)
      .single();

    if (error || !product)
      return res.status(404).json({ error: '상품을 찾을 수 없습니다' });

    res.json({ ok: true, product });
  } catch (err) {
    res.status(500).json({ error: '조회 오류' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      name, description, category, source_type, origin,
      weight_g, price, origin_price, stock, min_stock,
      expiry_days, is_subscribe, haccp, emoji, thumbnail_url
    } = req.body;

    if (!name || !category || !price)
      return res.status(400).json({ error: '이름, 카테고리, 가격은 필수입니다' });

    const { data: product, error } = await supabase
      .from('products')
      .insert({
        name, description, category, source_type, origin,
        weight_g, price, origin_price, stock: stock || 0,
        min_stock: min_stock || 10,
        expiry_days,
        is_subscribe: !!is_subscribe,
        haccp: !!haccp,
        emoji: emoji || '🥩',
        thumbnail_url,
        is_active: true
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, product });
  } catch (err) {
    console.error('[products/post]', err);
    res.status(500).json({ error: '상품 등록 오류' });
  }
});

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from('products')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, product });
  } catch (err) {
    res.status(500).json({ error: '상품 수정 오류' });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await supabase
      .from('products')
      .update({ is_active: false })
      .eq('id', req.params.id);

    res.json({ ok: true, message: '상품이 비활성화됐습니다' });
  } catch (err) {
    res.status(500).json({ error: '삭제 오류' });
  }
});

module.exports = router;
