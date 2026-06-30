const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');
const { sendKakaoMessage } = require('./campaigns');

// ════════════════════════════════════════════════════
// GET /api/crm/send-logs — 발송 로그 조회
// ════════════════════════════════════════════════════
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { campaign_id, status, page = 1, limit = 50 } = req.query;
    const from = (page - 1) * limit;
    const to   = from + Number(limit) - 1;

    let q = supabase
      .from('kakao_send_logs')
      .select('*, kakao_campaigns(campaign_name), kakao_templates(template_code, title)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (campaign_id) q = q.eq('campaign_id', campaign_id);
    if (status)      q = q.eq('status', status);

    const { data, error, count } = await q;
    if (error) throw error;

    res.json({ ok: true, total: count, page: Number(page), data });
  } catch (err) {
    console.error('[crm/send-logs GET]', err);
    res.status(500).json({ error: '발송 로그 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/crm/send-logs/:id/retry — 실패 발송 재시도
// ════════════════════════════════════════════════════
router.post('/:id/retry', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: log, error: logErr } = await supabase
      .from('kakao_send_logs')
      .select('*, kakao_templates(template_code)')
      .eq('id', id)
      .single();

    if (logErr || !log) return res.status(404).json({ error: '발송 로그를 찾을 수 없습니다' });
    if (log.status === '성공')  return res.status(409).json({ error: '이미 성공한 발송입니다' });
    if (log.retry_count >= 3)   return res.status(429).json({ error: '최대 재시도 횟수(3회)를 초과했습니다' });

    const result = await sendKakaoMessage({
      phone:        log.phone_number,
      templateCode: log.kakao_templates?.template_code,
      params:       {},
    });

    const newStatus = result.ok ? '성공' : '실패';

    const { data: updated, error: updErr } = await supabase
      .from('kakao_send_logs')
      .update({
        status:        newStatus,
        error_message: result.ok ? null : (result.error || '재시도 실패'),
        retry_count:   log.retry_count + 1,
        sent_at:       result.ok ? new Date().toISOString() : log.sent_at,
      })
      .eq('id', id)
      .select()
      .single();

    if (updErr) throw updErr;

    res.json({ ok: true, status: newStatus, data: updated });
  } catch (err) {
    console.error('[crm/send-logs/:id/retry]', err);
    res.status(500).json({ error: '재발송 오류' });
  }
});

module.exports = router;
