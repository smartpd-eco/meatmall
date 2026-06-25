const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

router.use(requireAdmin);

// ════════════════════════════════════════════════════
// GET /api/admin/categories — 카테고리 목록
// ════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .order('sort_order', { ascending: true });
    if (error) throw error;
    res.json({ ok: true, categories: data || [] });
  } catch (err) {
    console.error('[admin/categories GET]', err);
    res.status(500).json({ error: '카테고리 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/admin/categories — 카테고리 추가
// ════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const { slug, name, emoji, description } = req.body;
    if (!slug || !name) return res.status(400).json({ error: '슬러그와 이름은 필수입니다' });

    const { data: maxRow } = await supabase
      .from('categories')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1)
      .single();

    const sort_order = maxRow ? maxRow.sort_order + 1 : 1;

    const { data, error } = await supabase
      .from('categories')
      .insert({ slug, name, emoji: emoji || '🥩', description: description || '', sort_order })
      .select()
      .single();
    if (error) throw error;

    res.json({ ok: true, category: data });
  } catch (err) {
    console.error('[admin/categories POST]', err);
    if (err.code === '23505') return res.status(400).json({ error: '이미 존재하는 슬러그입니다' });
    res.status(500).json({ error: '카테고리 추가 오류' });
  }
});

// ════════════════════════════════════════════════════
// PUT /api/admin/categories/:id — 카테고리 수정 / 순서 변경
// ════════════════════════════════════════════════════
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { name, emoji, description, sort_order, is_active, move } = req.body;

    // 순서 이동
    if (move === 'up' || move === 'down') {
      const { data: cat, error: catErr } = await supabase
        .from('categories')
        .select('sort_order')
        .eq('id', id)
        .single();
      if (catErr || !cat) return res.status(404).json({ error: '카테고리를 찾을 수 없습니다' });

      let adjQuery = supabase.from('categories').select('id, sort_order');
      if (move === 'up') {
        adjQuery = adjQuery.lt('sort_order', cat.sort_order).order('sort_order', { ascending: false });
      } else {
        adjQuery = adjQuery.gt('sort_order', cat.sort_order).order('sort_order', { ascending: true });
      }
      const { data: adj } = await adjQuery.limit(1).single();
      if (!adj) return res.json({ ok: true });

      await Promise.all([
        supabase.from('categories').update({ sort_order: adj.sort_order }).eq('id', id),
        supabase.from('categories').update({ sort_order: cat.sort_order }).eq('id', adj.id)
      ]);
      return res.json({ ok: true });
    }

    // 일반 수정
    const update = { updated_at: new Date().toISOString() };
    if (name !== undefined)        update.name        = name;
    if (emoji !== undefined)       update.emoji       = emoji;
    if (description !== undefined) update.description = description;
    if (sort_order !== undefined)  update.sort_order  = Number(sort_order);
    if (is_active !== undefined)   update.is_active   = is_active;

    const { data, error } = await supabase
      .from('categories')
      .update(update)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    res.json({ ok: true, category: data });
  } catch (err) {
    console.error('[admin/categories PUT]', err);
    res.status(500).json({ error: '카테고리 수정 오류' });
  }
});

// ════════════════════════════════════════════════════
// DELETE /api/admin/categories/:id — 카테고리 삭제
// ════════════════════════════════════════════════════
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('categories')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/categories DELETE]', err);
    res.status(500).json({ error: '카테고리 삭제 오류' });
  }
});

module.exports = router;
