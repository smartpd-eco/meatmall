const express  = require('express');
const router   = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');
// campaigns.js 에서 export 된 범용 발송 함수 재사용
const { sendCampaignMessage } = require('./campaigns');

const MAX_RETRY = 3;

// ════════════════════════════════════════════════════
// GET /api/crm/send-logs — 발송 로그 목록
//   ?campaign_id=   ?status=성공|실패|대기
//   ?page=1&limit=50
// ════════════════════════════════════════════════════
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { campaign_id, status, page = 1, limit = 50 } = req.query;
    const from = (Number(page) - 1) * Number(limit);
    const to   = from + Number(limit) - 1;

    let q = supabase
      .from('kakao_send_logs')
      .select(
        '*, kakao_campaigns(campaign_name), kakao_templates(template_code, title)',
        { count: 'exact' }
      )
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
// POST /api/crm/send-logs/:id/retry — 실패건 재발송
//   - retry_count < MAX_RETRY(3) 인 경우만 허용
//   - 성공 시 status='성공', retry_count+1, sent_at 갱신
//   - 실패 시 status='실패', retry_count+1, error_message 갱신
// ════════════════════════════════════════════════════
router.post('/:id/retry', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // 로그 + 연결된 템플릿 조회
    const { data: log, error: logErr } = await supabase
      .from('kakao_send_logs')
      .select('*, kakao_templates(template_code)')
      .eq('id', id)
      .single();

    if (logErr || !log) {
      return res.status(404).json({ error: '발송 로그를 찾을 수 없습니다' });
    }
    if (log.status === '성공') {
      return res.status(409).json({ error: '이미 성공한 발송 건입니다' });
    }
    if (log.retry_count >= MAX_RETRY) {
      return res.status(429).json({
        error: `최대 재시도 횟수(${MAX_RETRY}회)를 초과했습니다`,
        retry_count: log.retry_count,
      });
    }

    const templateCode = log.kakao_templates?.template_code;
    if (!templateCode) {
      return res.status(400).json({ error: '연결된 템플릿 코드를 찾을 수 없습니다' });
    }

    // 재발송 — sendCampaignMessage 재사용
    const result = await sendCampaignMessage({
      phone:        log.phone_number,
      templateCode,
      params:       {},  // 재발송은 원본 파라미터 보존 불가 → 빈 params
    });

    const newStatus = result.ok ? '성공' : '실패';
    const now       = new Date().toISOString();

    const { data: updated, error: updErr } = await supabase
      .from('kakao_send_logs')
      .update({
        status:        newStatus,
        error_message: result.ok ? null : (result.error || '재발송 실패'),
        retry_count:   log.retry_count + 1,
        sent_at:       result.ok ? now : log.sent_at,
      })
      .eq('id', id)
      .select()
      .single();

    if (updErr) throw updErr;

    res.json({ ok: true, status: newStatus, retry_count: updated.retry_count, data: updated });
  } catch (err) {
    console.error('[crm/send-logs/:id/retry]', err);
    res.status(500).json({ error: '재발송 오류' });
  }
});

module.exports = router;
