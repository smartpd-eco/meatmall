const express = require('express');
const router  = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

// ════════════════════════════════════════════════════
// POST /api/upload/image — Supabase Storage 업로드
// ════════════════════════════════════════════════════
router.post('/image', requireAdmin, async (req, res) => {
  try {
    const { base64, contentType } = req.body;
    if (!base64) return res.status(400).json({ error: '이미지 데이터가 없습니다' });

    // data:image/jpeg;base64,... 형식에서 순수 base64 추출
    const raw = base64.includes(',') ? base64.split(',')[1] : base64;
    const mime = base64.includes(';')
      ? base64.split(';')[0].split(':')[1]
      : (contentType || 'image/jpeg');
    const ext  = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const path = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const buffer = Buffer.from(raw, 'base64');

    const { error: upErr } = await supabase.storage
      .from('products')
      .upload(path, buffer, { contentType: mime, upsert: false });

    if (upErr) throw upErr;

    const { data: { publicUrl } } = supabase.storage
      .from('products')
      .getPublicUrl(path);

    res.json({ ok: true, url: publicUrl });
  } catch (err) {
    console.error('[upload/image]', err);
    res.status(500).json({ error: err.message || '이미지 업로드 실패' });
  }
});

module.exports = router;
