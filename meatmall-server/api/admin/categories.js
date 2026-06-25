const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

router.use(requireAdmin);

// ════════════════════════════════════════════════════
// GET /api/admin/categories — 목록 + 카테고리별 상품수
// ════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const [{ data: cats, error }, { data: products }] = await Promise.all([
      supabase.from('categories').select('*').order('sort_order', { ascending: true }),
      supabase.from('products').select('category')
    ]);
    if (error) throw error;

    const counts = {};
    (products || []).forEach(p => {
      if (p.category) counts[p.category] = (counts[p.category] || 0) + 1;
    });

    const categories = (cats || []).map(c => ({
      ...c,
      product_count: counts[c.name] || 0
    }));

    res.json({ ok: true, categories });
  } catch (err) {
    console.error('[admin/categories GET]', err);
    res.status(500).json({ error: '카테고리 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/admin/categories — 카테고리 추가 { name }
// ════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '카테고리 이름은 필수입니다' });

    const { data: maxRow } = await supabase
      .from('categories')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1)
      .single();

    const sort_order = maxRow ? maxRow.sort_order + 1 : 1;

    const { data, error } = await supabase
      .from('categories')
      .insert({ name: name.trim(), sort_order })
      .select()
      .single();
    if (error) throw error;

    res.json({ ok: true, category: data });
  } catch (err) {
    console.error('[admin/categories POST]', err);
    if (err.code === '23505') return res.status(400).json({ error: '이미 존재하는 카테고리 이름입니다' });
    res.status(500).json({ error: '카테고리 추가 오류' });
  }
});

// ════════════════════════════════════════════════════
// DELETE /api/admin/categories/:id — 삭제 (상품 있으면 400)
// ════════════════════════════════════════════════════
router.delete('/:id', async (req, res) => {
  try {
    const { data: cat, error: catErr } = await supabase
      .from('categories')
      .select('name')
      .eq('id', req.params.id)
      .single();
    if (catErr || !cat) return res.status(404).json({ error: '카테고리를 찾을 수 없습니다' });

    const { count } = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('category', cat.name);

    if (count > 0) {
      return res.status(400).json({ error: `"${cat.name}" 카테고리에 상품 ${count}개가 있어 삭제할 수 없습니다` });
    }

    const { error } = await supabase.from('categories').delete().eq('id', req.params.id);
    if (error) throw error;

    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/categories DELETE]', err);
    res.status(500).json({ error: '카테고리 삭제 오류' });
  }
});

module.exports = router;
