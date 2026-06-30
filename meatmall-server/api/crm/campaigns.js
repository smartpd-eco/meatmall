const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

// ── 카카오 메시지 발송 (템플릿 코드 기반) ─────────────────
async function sendKakaoMessage({ phone, templateCode, params = {} }) {
  const apiKey    = process.env.KAKAO_ALIMTALK_API_KEY;
  const senderKey = process.env.KAKAO_ALIMTALK_SENDER_KEY;

  if (!apiKey || !senderKey) {
    console.log(`[카카오 DEV] to:${phone} template:${templateCode}`, params);
    return { ok: true, dev: true };
  }

  try {
    const body = {
      senderKey,
      templateCode,
      recipientList: [{
        recipientNo:       phone.replace(/-/g, ''),
        templateParameter: params,
      }],
    };
    const res = await fetch('https://api-alimtalk.kakao.com/v2/messages', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json;charset=UTF-8',
        'Authorization': apiKey,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (err) {
    console.error('[카카오 발송 오류]', err);
    return { ok: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════
// GET /api/crm/campaigns — 캠페인 목록
// ════════════════════════════════════════════════════
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const from = (page - 1) * limit;
    const to   = from + Number(limit) - 1;

    let q = supabase
      .from('kakao_campaigns')
      .select('*, kakao_templates(template_code, title, template_type)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (status) q = q.eq('status', status);

    const { data, error, count } = await q;
    if (error) throw error;

    res.json({ ok: true, total: count, page: Number(page), data });
  } catch (err) {
    console.error('[crm/campaigns GET]', err);
    res.status(500).json({ error: '캠페인 조회 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/crm/campaigns — 캠페인 생성
// ════════════════════════════════════════════════════
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { campaign_name, template_id, target_segment, scheduled_at } = req.body;

    if (!campaign_name || !template_id) {
      return res.status(400).json({ error: 'campaign_name, template_id 는 필수입니다' });
    }

    const { data, error } = await supabase
      .from('kakao_campaigns')
      .insert({ campaign_name, template_id, target_segment: target_segment || null, scheduled_at: scheduled_at || null, status: '예약' })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, data });
  } catch (err) {
    console.error('[crm/campaigns POST]', err);
    res.status(500).json({ error: '캠페인 생성 오류' });
  }
});

// ════════════════════════════════════════════════════
// PUT /api/crm/campaigns/:id — 캠페인 수정
// ════════════════════════════════════════════════════
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { campaign_name, target_segment, scheduled_at, status } = req.body;

    const updates = {};
    if (campaign_name  !== undefined) updates.campaign_name  = campaign_name;
    if (target_segment !== undefined) updates.target_segment = target_segment;
    if (scheduled_at   !== undefined) updates.scheduled_at   = scheduled_at;
    if (status         !== undefined) {
      if (!['예약', '발송중', '완료', '실패'].includes(status)) {
        return res.status(400).json({ error: 'status 는 예약/발송중/완료/실패 만 허용됩니다' });
      }
      updates.status = status;
    }

    const { data, error } = await supabase
      .from('kakao_campaigns')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: '캠페인을 찾을 수 없습니다' });

    res.json({ ok: true, data });
  } catch (err) {
    console.error('[crm/campaigns PUT]', err);
    res.status(500).json({ error: '캠페인 수정 오류' });
  }
});

// ════════════════════════════════════════════════════
// DELETE /api/crm/campaigns/:id — 캠페인 삭제
// ════════════════════════════════════════════════════
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // 발송중인 캠페인은 삭제 금지
    const { data: campaign } = await supabase
      .from('kakao_campaigns')
      .select('status')
      .eq('id', id)
      .single();

    if (campaign?.status === '발송중') {
      return res.status(409).json({ error: '발송 중인 캠페인은 삭제할 수 없습니다' });
    }

    const { error } = await supabase
      .from('kakao_campaigns')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[crm/campaigns DELETE]', err);
    res.status(500).json({ error: '캠페인 삭제 오류' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/crm/campaigns/:id/send — 캠페인 즉시 발송
// ════════════════════════════════════════════════════
router.post('/:id/send', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    // 캠페인 + 템플릿 조회
    const { data: campaign, error: campErr } = await supabase
      .from('kakao_campaigns')
      .select('*, kakao_templates(*)')
      .eq('id', id)
      .single();

    if (campErr || !campaign) return res.status(404).json({ error: '캠페인을 찾을 수 없습니다' });
    if (campaign.status === '발송중') return res.status(409).json({ error: '이미 발송 중입니다' });
    if (campaign.status === '완료')   return res.status(409).json({ error: '이미 완료된 캠페인입니다' });

    const template = campaign.kakao_templates;
    if (!template || template.status !== '승인') {
      return res.status(400).json({ error: '승인된 템플릿이 없습니다' });
    }

    // 발송 대상 조회 (target_segment 필터)
    const seg = campaign.target_segment;
    let usersQuery = supabase.from('users').select('id, name, phone');

    if (seg?.grade) {
      const { data: segUsers } = await supabase
        .from('customer_segments')
        .select('user_id')
        .eq('grade', seg.grade);
      const ids = (segUsers || []).map(s => s.user_id);
      if (ids.length === 0) {
        return res.json({ ok: true, sent: 0, message: '해당 등급 대상자 없음' });
      }
      usersQuery = usersQuery.in('id', ids);
    }

    const { data: users, error: usrErr } = await usersQuery.not('phone', 'is', null);
    if (usrErr) throw usrErr;

    // 발송중으로 상태 전환
    await supabase
      .from('kakao_campaigns')
      .update({ status: '발송중' })
      .eq('id', id);

    let success = 0;
    let fail    = 0;

    for (const user of users) {
      const result = await sendKakaoMessage({
        phone:        user.phone,
        templateCode: template.template_code,
        params:       { '#{고객명}': user.name || '고객' },
      });

      const logStatus = result.ok ? '성공' : '실패';
      if (result.ok) success++; else fail++;

      await supabase.from('kakao_send_logs').insert({
        campaign_id:  campaign.id,
        user_id:      user.id,
        template_id:  template.id,
        phone_number: user.phone,
        status:       logStatus,
        error_message: result.error || null,
        sent_at:      new Date().toISOString(),
      });
    }

    // 완료 처리
    await supabase
      .from('kakao_campaigns')
      .update({
        status:        fail > 0 && success === 0 ? '실패' : '완료',
        sent_count:    users.length,
        success_count: success,
        fail_count:    fail,
      })
      .eq('id', id);

    res.json({ ok: true, sent: users.length, success, fail });
  } catch (err) {
    console.error('[crm/campaigns/:id/send]', err);
    // 오류 시 캠페인 상태를 실패로 전환
    await supabase.from('kakao_campaigns').update({ status: '실패' }).eq('id', id);
    res.status(500).json({ error: '캠페인 발송 오류' });
  }
});

module.exports = router;
module.exports.sendKakaoMessage = sendKakaoMessage;
