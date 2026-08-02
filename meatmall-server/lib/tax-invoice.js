// ════════════════════════════════════════════════════
//  전자세금계산서 발행 모듈 — 대행사(팝빌/바로빌) 연동 지점
//  - 환경변수(POPBILL_LINK_ID, POPBILL_SECRET_KEY, POPBILL_CORP_NUM)가 있으면 실발행 시도.
//  - 없으면 pending 반환(오발행 방지, 기존 무영향). 계약·키 확보 후 아래 TODO에 SDK 연동.
// ════════════════════════════════════════════════════

async function issueTaxInvoice({ deal, supplier, buyer }) {
  const configured = !!(process.env.POPBILL_LINK_ID && process.env.POPBILL_SECRET_KEY && process.env.POPBILL_CORP_NUM);

  if (!configured) {
    return {
      ok: false, pending: true, provider: 'manual',
      message: '전자세금계산서 대행사(팝빌) 미설정 — "발행 대기"로 기록됐습니다. 계약·키 등록 후 자동 발행됩니다.'
    };
  }

  try {
    // TODO(팝빌 연동): popbill TaxinvoiceService 로 작성→즉시발행
    //   공급자   : supplier.biz_reg_no / company_name / ceo_name / address / biz_type / biz_item
    //   공급받는자: buyer.biz_reg_no / company_name / ceo_name / tax_email
    //   금액     : 공급가액 deal.supply_amount / 세액 deal.vat / 합계 deal.total_amount
    //   품목     : deal.item_name / 수량 deal.qty / 단가 deal.unit_price
    //   발행 후 반환: { ok:true, provider:'popbill', mgtKey, ntsConfirmNo, pdfUrl }
    return {
      ok: false, pending: true, provider: 'popbill',
      message: '팝빌 키 확인됨 — SDK 연동(다음 배포)에서 국세청 실발행됩니다.'
    };
  } catch (e) {
    return { ok: false, pending: false, provider: 'popbill', error: e.message || String(e) };
  }
}

module.exports = { issueTaxInvoice };
