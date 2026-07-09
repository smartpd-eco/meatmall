// ════════════════════════════════════════════════════
//  Solapi 카카오 알림톡 발송 모듈
//  - API Key/Secret/Sender/PFID/템플릿코드는 전부 환경변수에서만 로드
//  - 발송 결과를 notifications / notification_logs 테이블에 저장
//  - 미설정 시 DEV 폴백(실제 발송 없이 성공 로그)
// ════════════════════════════════════════════════════
const { SolapiMessageService } = require('solapi');
const supabase = require('./supabase');

// 환경변수 값 정리: BOM(U+FEFF)·제로폭·앞뒤 공백/따옴표 제거
// (일부 등록 과정에서 값에 BOM이 섞여 HMAC 헤더 생성이 깨지는 문제 방어)
function envClean(v) {
  return String(v || '')
    .replace(/[\uFEFF\u200B-\u200D\u2060]/g, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

const CFG = {
  apiKey:    envClean(process.env.SOLAPI_API_KEY),
  apiSecret: envClean(process.env.SOLAPI_API_SECRET),
  sender:    envClean(process.env.SOLAPI_SENDER || process.env.ALIMTALK_SENDER_NO),
  pfId:      envClean(process.env.SOLAPI_PFID),
};

// 휴대폰 번호 정규화: 숫자만 → 01012345678 형식
function normalizePhone(p) {
  return String(p || '').replace(/[^0-9]/g, '');
}

// 발송 준비 여부 (키·발신번호·채널 모두 있어야 실제 발송)
function isConfigured() {
  return !!(CFG.apiKey && CFG.apiSecret && CFG.pfId && CFG.sender);
}

// ── 내부: 로그 저장 ──
async function writeLog(notificationId, success, code, message, raw) {
  try {
    await supabase.from('notification_logs').insert([{
      notification_id: notificationId || null,
      provider: 'solapi',
      success: !!success,
      result_code: String(code || ''),
      result_message: String(message || '').slice(0, 500),
      raw_response: raw || {},
    }]);
  } catch (e) {
    console.error('[notification_logs 저장 오류]', e.message);
  }
}

// ── 내부: 상태 업데이트 ──
async function markStatus(notificationId, status) {
  if (!notificationId) return;
  try {
    await supabase.from('notifications')
      .update({ status, sent_at: status === 'sent' ? new Date().toISOString() : null })
      .eq('id', notificationId);
  } catch (e) {
    console.error('[notifications 상태 업데이트 오류]', e.message);
  }
}

// ════════════════════════════════════════════════════
//  알림톡 발송 (공통)
//  { type, phone, name, templateCode, variables, dedupeKey }
//  - dedupeKey(주문번호 등): 동일 type+key로 이미 성공 발송 시 재발송 방지
// ════════════════════════════════════════════════════
async function sendAlimtalk({ type, phone, name, templateCode, variables, dedupeKey }) {
  const to = normalizePhone(phone);
  if (!to || to.length < 10) {
    return { ok: false, error: '유효하지 않은 전화번호입니다' };
  }
  templateCode = String(templateCode || '').replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').trim();
  if (!templateCode) {
    return { ok: false, error: '템플릿 코드가 설정되지 않았습니다 (환경변수 확인)' };
  }

  // 중복 발송 방지 — 이미 성공 발송된 동일 건이 있으면 skip
  if (dedupeKey) {
    try {
      const { data: dup } = await supabase.from('notifications')
        .select('id')
        .eq('type', type)
        .eq('status', 'sent')
        .filter('payload->>dedupeKey', 'eq', String(dedupeKey))
        .limit(1);
      if (dup && dup.length) {
        return { ok: true, skipped: true, reason: '중복 발송 방지 (이미 발송됨)' };
      }
    } catch (e) { /* 조회 실패는 무시하고 계속 진행 */ }
  }

  // notifications 레코드 생성 (pending)
  let notificationId = null;
  try {
    const { data: noti } = await supabase.from('notifications').insert([{
      type,
      receiver_phone: to,
      receiver_name: name || null,
      template_code: templateCode,
      payload: { variables, dedupeKey: dedupeKey ? String(dedupeKey) : null },
      status: 'pending',
    }]).select().single();
    notificationId = noti && noti.id;
  } catch (e) {
    console.error('[notifications 생성 오류]', e.message);
  }

  // DEV 폴백 — 키 미설정 시 실제 발송 없이 성공 처리
  if (!isConfigured()) {
    console.log(`[알림톡 DEV] type:${type} to:${to} template:${templateCode}`, variables);
    await writeLog(notificationId, true, 'DEV', 'DEV 모드 — 실제 발송 안 함', { dev: true, variables });
    await markStatus(notificationId, 'sent');
    return { ok: true, dev: true, notificationId };
  }

  // 실제 발송
  try {
    const service = new SolapiMessageService(CFG.apiKey, CFG.apiSecret);
    const result = await service.send({
      to,
      from: normalizePhone(CFG.sender),
      kakaoOptions: {
        pfId: CFG.pfId,
        templateId: templateCode,
        variables: variables || {},
      },
    });
    await writeLog(notificationId, true, 'OK', '발송 성공', result);
    await markStatus(notificationId, 'sent');
    return { ok: true, notificationId, data: result };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    const code = (err && (err.errorCode || err.code)) || 'ERR';
    console.error('[Solapi 발송 오류]', code, msg);
    await writeLog(notificationId, false, code, msg, { error: msg });
    await markStatus(notificationId, 'failed');
    return { ok: false, error: msg, notificationId };
  }
}

module.exports = { sendAlimtalk, normalizePhone, isConfigured, CFG };
