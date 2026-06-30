const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

// notify/index.js 에서 사용 가능한 특정 알림 함수 import (재사용)
// sendAlimtalk(범용) 은 notify/index.js 에서 export 되지 않으므로
// 동일 패턴으로 sendCampaignMessage 를 로컬 구현 후 export
const {
  notifyOrderComplete,
  notifyShippingStart,
  notifyPaymentFail,
  notifyCSAnswer,
} = require('../notify/index');

// ── 범용 카카오 발송 (DB 템플릿 코드 + 동적 파라미터 지원) ──────
async function sendCampaignMessage({ phone, templateCode, params = {} }) {
  const apiKey    = process.env.KAKAO_ALIMTALK_API_KEY;
  const senderKey = process.env.KAKAO_ALIMTALK_SENDER_KEY;

  if (!apiKey || !senderKey) {
    // 키 미설정 시 DEV 모드 — 실제 발송 없이 성공으로 처리
    console.log(`[캠페인 DEV] to:${phone} template:${templateCode}`, params);
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
      method:  'POST',
      headers: {
        'Content-Type':  'application/json;charset=UTF-8',
        'Authorization': apiKey,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return { ok: res.ok, data };
  } catch (err) {
    console.error('[캠페인 발송 오류]', err);
    return { ok: false, error: err.message };
  }
}

// ── target_segment 조건으로 발송 대상자 추출 ─────────────────────
//   지원 형식:
//     {"grade": ["VIP","GOLD"]}        → customer_segments.grade IN [...]
//     {"churn_risk_min": 0.6}          → customer_segments.churn_risk_score >= 0.6
//     null / {}                        → 전체 활성 유저
async function resolveTargetUsers(target_segment) {
  let segQuery = supabase
    .from('customer_segments')
    .select('user_id, grade, churn_risk_score, users(id, name, phone)')
    .not('users.phone', 'is', null);

  const seg = target_segment || {};

  if (seg.grade && Array.isArray(seg.grade) && seg.grade.length > 0) {
    segQuery = segQuery.in('grade', seg.grade);
  }

  if (typeof seg.churn_risk_min === 'number') {
    segQuery = segQuery.gte('churn_risk_score', seg.churn_risk_min);
  }

  const { data, error } = await segQuery;
  if (error) throw error;

  // users 조인 결과 정제 — phone 없는 경우 제외
  return (data || [])
    .map(row => row.users)
    .filter(u => u && u.phone);
}

// ════════════════════════════════════════════════════
// GET /api/crm/campaigns — 캠페인 목록
//   ?status=예약|발송중|완료|실패   ?page=1&limit=20
// ════════════════════════════════════════════════════
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const from = (Number(page) - 1) * Number(limit);
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
// body: { campaign_name, template_id, target_segment?, scheduled_at? }
// ════════════════════════════════════════════════════
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { campaign_name, template_id, target_segment, scheduled_at } = req.body;

    if (!campaign_name || !template_id) {
      return res.status(400).json({ error: 'campaign_name, template_id 는 필수입니다' });
    }

    const { data, error } = await supabase
      .from('kakao_campaigns')
      .insert({
        campaign_name,
        template_id,
        target_segment: target_segment || null,
        scheduled_at:   scheduled_at   || null,
        status:         '예약',
      })
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
// body: { campaign_name?, target_segment?, scheduled_at?, status? }
// ════════════════════════════════════════════════════
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { campaign_name, target_segment, scheduled_at, status } = req.body;

    const updates = {};
    if (campaign_name  !== undefined) updates.campaign_name  = campaign_name;
    if (target_segment !== undefined) updates.target_segment = target_segment;
    if (scheduled_at   !== undefined) updates.scheduled_at   = scheduled_at;
    if (status !== undefined) {
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
// POST /api/crm/campaigns/:id/send — 즉시 발송 실행
//
//   흐름:
//   1. 캠페인 + 템플릿(status='승인') 확인
//   2. target_segment → customer_segments + users 조인으로 대상자 추출
//   3. 대상자별 sendCampaignMessage 호출
//   4. 결과를 kakao_send_logs 에 건별 insert
//   5. campaigns.sent_count / success_count / fail_count 업데이트
//   6. status '발송중' → '완료'(또는 '실패') 변경
// ════════════════════════════════════════════════════
router.post('/:id/send', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    // ── 캠페인 + 템플릿 조회
    const { data: campaign, error: campErr } = await supabase
      .from('kakao_campaigns')
      .select('*, kakao_templates(*)')
      .eq('id', id)
      .single();

    if (campErr || !campaign) {
      return res.status(404).json({ error: '캠페인을 찾을 수 없습니다' });
    }
    if (campaign.status === '발송중') {
      return res.status(409).json({ error: '이미 발송 중입니다' });
    }
    if (campaign.status === '완료') {
      return res.status(409).json({ error: '이미 완료된 캠페인입니다' });
    }

    const template = campaign.kakao_templates;
    if (!template) {
      return res.status(400).json({ error: '연결된 템플릿이 없습니다' });
    }
    if (template.status !== '승인') {
      return res.status(400).json({ error: `템플릿이 승인 상태가 아닙니다 (현재: ${template.status})` });
    }

    // ── 발송중 상태로 전환
    await supabase
      .from('kakao_campaigns')
      .update({ status: '발송중' })
      .eq('id', id);

    // ── 대상자 추출 (customer_segments + users 조인)
    const users = await resolveTargetUsers(campaign.target_segment);

    if (users.length === 0) {
      await supabase
        .from('kakao_campaigns')
        .update({ status: '완료', sent_count: 0 })
        .eq('id', id);
      return res.json({ ok: true, sent: 0, success: 0, fail: 0, message: '발송 대상자 없음' });
    }

    // ── 건별 발송 + 로그 누적
    let success = 0;
    let fail    = 0;
    const logs  = [];

    for (const user of users) {
      const params = { '#{고객명}': user.name || '고객' };
      const result = await sendCampaignMessage({
        phone:        user.phone,
        templateCode: template.template_code,
        params,
      });

      const logStatus = result.ok ? '성공' : '실패';
      if (result.ok) success++; else fail++;

      logs.push({
        campaign_id:   campaign.id,
        user_id:       user.id,
        template_id:   template.id,
        phone_number:  user.phone,
        status:        logStatus,
        error_message: result.ok ? null : (result.error || '발송 실패'),
        retry_count:   0,
        sent_at:       result.ok ? new Date().toISOString() : null,
      });
    }

    // ── 로그 일괄 insert
    if (logs.length > 0) {
      const { error: logErr } = await supabase
        .from('kakao_send_logs')
        .insert(logs);
      if (logErr) console.error('[send logs insert]', logErr);
    }

    // ── 캠페인 통계 + 완료 처리
    const finalStatus = success === 0 ? '실패' : '완료';
    await supabase
      .from('kakao_campaigns')
      .update({
        status:        finalStatus,
        sent_count:    users.length,
        success_count: success,
        fail_count:    fail,
      })
      .eq('id', id);

    res.json({ ok: true, sent: users.length, success, fail });
  } catch (err) {
    console.error('[crm/campaigns/:id/send]', err);
    // 오류 발생 시 캠페인 상태를 실패로 전환
    await supabase.from('kakao_campaigns').update({ status: '실패' }).eq('id', id);
    res.status(500).json({ error: '캠페인 발송 오류' });
  }
});

module.exports = router;
module.exports.sendCampaignMessage = sendCampaignMessage;
