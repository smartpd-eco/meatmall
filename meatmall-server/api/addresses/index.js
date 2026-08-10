const express = require('express');
const router  = express.Router();
const supabase = require('../../lib/supabase');
const { requireAuth } = require('../../middleware/auth');
const { verifyPhoneVerifyToken } = require('../../lib/jwt');
const { normalizePhone } = require('../../lib/solapi');

function assertPhoneVerified(req, phone, token) {
  const decoded = verifyPhoneVerifyToken(token);
  return !!(
    decoded &&
    decoded.sub === req.user.sub &&
    normalizePhone(decoded.phone) === normalizePhone(phone)
  );
}

// ════════════════════════════════════════════════════
// GET /api/addresses — 내 배송지 목록
// ════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('addresses')
      .select('*')
      .eq('user_id', req.user.sub)
      .order('is_default', { ascending: false })
      .order('created_at',  { ascending: false });
    if (error) throw error;
    res.json({ ok: true, addresses: data || [] });
  } catch (err) {
    console.error('[addresses/get]', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// POST /api/addresses — 배송지 추가
// ════════════════════════════════════════════════════
router.post('/', requireAuth, async (req, res) => {
  try {
    const { recipient, phone, zip_code, address1, address2, delivery_note, is_default, phoneVerifyToken } = req.body;
    if (!recipient || !phone || !zip_code || !address1)
      return res.status(400).json({ error: '수령인, 휴대폰, 우편번호, 주소는 필수입니다' });
    if (!assertPhoneVerified(req, phone, phoneVerifyToken)) {
      return res.status(400).json({ error: '휴대폰 인증을 완료해주세요' });
    }

    const userId = req.user.sub;

    if (is_default)
      await supabase.from('addresses').update({ is_default: false }).eq('user_id', userId);

    const { data, error } = await supabase
      .from('addresses')
      .insert({
        user_id:       userId,
        recipient,
        phone,
        zip_code,
        address1,
        address2:      address2      || '',
        delivery_note: delivery_note || '',
        is_default:    !!is_default
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ ok: true, address: data });
  } catch (err) {
    console.error('[addresses/post]', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// PUT /api/addresses/:id/default — 기본 배송지 설정
// ★ /:id 보다 먼저 등록해야 라우팅 충돌 없음
// ════════════════════════════════════════════════════
router.put('/:id/default', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    await supabase.from('addresses').update({ is_default: false }).eq('user_id', userId);

    const { data, error } = await supabase
      .from('addresses')
      .update({ is_default: true })
      .eq('id',      req.params.id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: '배송지를 찾을 수 없습니다' });
    res.json({ ok: true, address: data });
  } catch (err) {
    console.error('[addresses/default]', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// PUT /api/addresses/:id — 배송지 수정
// ════════════════════════════════════════════════════
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { recipient, phone, zip_code, address1, address2, delivery_note, is_default, phoneVerifyToken } = req.body;
    const userId = req.user.sub;

    const { data: existing } = await supabase
      .from('addresses').select('id, phone').eq('id', req.params.id).eq('user_id', userId).single();
    if (!existing) return res.status(404).json({ error: '배송지를 찾을 수 없습니다' });
    if (normalizePhone(existing.phone) !== normalizePhone(phone) && !assertPhoneVerified(req, phone, phoneVerifyToken)) {
      return res.status(400).json({ error: '휴대폰 인증을 완료해주세요' });
    }

    if (is_default)
      await supabase.from('addresses').update({ is_default: false }).eq('user_id', userId);

    const { data, error } = await supabase
      .from('addresses')
      .update({
        recipient,
        phone,
        zip_code,
        address1,
        address2:      address2      || '',
        delivery_note: delivery_note || '',
        is_default:    !!is_default
      })
      .eq('id',      req.params.id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, address: data });
  } catch (err) {
    console.error('[addresses/put]', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// DELETE /api/addresses/:id — 배송지 삭제
// ════════════════════════════════════════════════════
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('addresses')
      .delete()
      .eq('id',      req.params.id)
      .eq('user_id', req.user.sub);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[addresses/delete]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
