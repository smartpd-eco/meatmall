const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

// ════════════════════════════════════════════════════
// GET /api/crm/templates — 템플릿 목록
// ════════════════════════════════════════════════════
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { type, status } = req.query;

    let q = supabase
      .from('kakao_templates')
      .select('*')
      .order('created_at', { ascending: false });

    if (type)   q = q.eq('template_type', type);
    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;

    res.json({ ok: true, data });
  } catch (err) {
    console.error('[crm/templates GET]', err);
    res.status(500).json({ error: '템플릿 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/crm/templates — 템플릿 생성
// ════════════════════════════════════════════════════
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { template_code, template_type, title, content, button_config } = req.body;

    if (!template_code || !template_type || !title || !content) {
      return res.status(400).json({ error: 'template_code, template_type, title, content 는 필수입니다' });
    }
    if (!['알림톡', '친구톡'].includes(template_type)) {
      return res.status(400).json({ error: 'template_type 은 알림톡 또는 친구톡 이어야 합니다' });
    }

    const { data, error } = await supabase
      .from('kakao_templates')
      .insert({ template_code, template_type, title, content, button_config: button_config || null, status: '대기' })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, data });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: '이미 존재하는 template_code 입니다' });
    }
    console.error('[crm/templates POST]', err);
    res.status(500).json({ error: '템플릿 생성 오류' });
  }
});

// ════════════════════════════════════════════════════
// PUT /api/crm/templates/:id — 템플릿 수정
// ════════════════════════════════════════════════════
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, button_config, status } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (title         !== undefined) updates.title         = title;
    if (content       !== undefined) updates.content       = content;
    if (button_config !== undefined) updates.button_config = button_config;
    if (status        !== undefined) {
      if (!['대기', '승인', '반려'].includes(status)) {
        return res.status(400).json({ error: 'status 는 대기/승인/반려 만 허용됩니다' });
      }
      updates.status = status;
    }

    const { data, error } = await supabase
      .from('kakao_templates')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다' });

    res.json({ ok: true, data });
  } catch (err) {
    console.error('[crm/templates PUT]', err);
    res.status(500).json({ error: '템플릿 수정 오류' });
  }
});

// ════════════════════════════════════════════════════
// DELETE /api/crm/templates/:id — 템플릿 삭제
// ════════════════════════════════════════════════════
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('kakao_templates')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: '캠페인에서 사용 중인 템플릿은 삭제할 수 없습니다' });
    }
    console.error('[crm/templates DELETE]', err);
    res.status(500).json({ error: '템플릿 삭제 오류' });
  }
});

module.exports = router;
