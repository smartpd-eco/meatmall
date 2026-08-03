// ════════════════════════════════════════════════════
//  B2B 잉여/임박 재고 거래소 API (신규 라우트, 기존 무영향)
//  회원(사업자) · 게시판 · 상세 · 거래 · 여신 · 세금계산서
// ════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAuth, requireAdmin, optionalAuth } = require('../../middleware/auth');
const { issueTaxInvoice } = require('../../lib/tax-invoice');
const { kakaoGeocode } = require('../../lib/geocode'); // 업체 주소 → 좌표(거리매칭)

const VAT_RATE = 0.1;

// ── 공개범위/단가공개 유틸 ──
function canView(l, m) {
  const v = l.visibility || 'public';
  if (v === 'public') return true;
  if (!m) return false;
  if (l.seller_id === m.id) return true;
  if (v === 'selected') return (l.allowed_members || []).map(Number).includes(m.id);
  return false; // private
}
function priceHidden(l, m) {
  const pv = l.price_visibility || 'public';
  if (pv === 'public') return false;
  if (pv === 'inquiry') return true;
  if (!m) return true;                       // selected
  if (l.seller_id === m.id) return false;
  return !(l.allowed_members || []).map(Number).includes(m.id);
}
function maskPrice(l, m) {
  return priceHidden(l, m) ? { ...l, unit_price: null, price_hidden: true } : { ...l, price_hidden: false };
}

// ── 단가 우선순위 엔진: 계약단가 > 등급단가 > 행사단가 > 기본단가 ──
async function resolvePrice({ sellerId, buyerId, itemName, qty = 0, basePrice = null, grade = 'basic' }) {
  const today = new Date().toISOString().slice(0, 10);
  // 1) 계약단가 (거래처별, min_qty·유효기간)
  if (sellerId && buyerId && itemName) {
    const { data: cp } = await supabase.from('b2b_contract_prices')
      .select('unit_price, min_qty, valid_from, valid_to')
      .eq('seller_id', sellerId).eq('buyer_id', buyerId).eq('item_name', itemName).eq('active', true)
      .lte('min_qty', qty || 0).order('min_qty', { ascending: false }).limit(10);
    const valid = (cp || []).filter(r => (!r.valid_from || r.valid_from <= today) && (!r.valid_to || r.valid_to >= today));
    if (valid.length) return { price: Number(valid[0].unit_price), tier: 'contract' };
  }
  // 2) 등급단가
  if (sellerId && grade && itemName) {
    const { data: gp } = await supabase.from('b2b_grade_prices')
      .select('unit_price').eq('seller_id', sellerId).eq('grade', grade).eq('item_name', itemName).eq('active', true).limit(1);
    if (gp && gp.length) return { price: Number(gp[0].unit_price), tier: 'grade' };
  }
  // 3) 행사단가 — (미구현, 추후 promo 테이블)
  // 4) 기본단가
  if (basePrice != null && basePrice !== '') return { price: Number(basePrice), tier: 'base' };
  return { price: null, tier: 'none' };
}

function dealNo() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `B2B-${d}-${r}`;
}

// 현재 로그인 유저의 B2B 회원 레코드
async function currentMember(req) {
  const { data } = await supabase.from('b2b_members').select('*').eq('user_id', req.user.sub).maybeSingle();
  return data || null;
}
function isApproved(m) { return m && m.status === 'approved'; }

// ── 회원: 가입 신청 (승인 전 pending) ──
router.post('/members/register', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.company_name || !b.biz_reg_no) return res.status(400).json({ error: '상호와 사업자등록번호는 필수입니다' });
    const exist = await currentMember(req);
    if (exist) return res.status(400).json({ error: '이미 B2B 회원 신청/가입 상태입니다', member: exist });

    // 주소 → 좌표(거리매칭용). KAKAO 키 없으면 null.
    let geo = null;
    if (b.address) { try { geo = await kakaoGeocode(b.address); } catch (e) {} }
    const { data, error } = await supabase.from('b2b_members').insert({
      user_id: req.user.sub,
      company_name: b.company_name, biz_reg_no: String(b.biz_reg_no).replace(/[^0-9]/g, ''),
      ceo_name: b.ceo_name || null, biz_type: b.biz_type || null, biz_item: b.biz_item || null,
      address: b.address || null, contact_phone: b.contact_phone || null,
      contact_email: b.contact_email || null, tax_email: b.tax_email || b.contact_email || null,
      moq: b.moq != null && b.moq !== '' ? Number(b.moq) : null,
      payment_terms: b.payment_terms || null, delivery_area: b.delivery_area || null,
      lat: geo ? geo.lat : null, lng: geo ? geo.lng : null,
      status: 'pending'
    }).select().single();
    if (error) throw error;
    res.status(201).json({ ok: true, member: data, message: '신청 완료 — 관리자 사업자 확인 후 승인됩니다' });
  } catch (err) { console.error('[b2b/register]', err); res.status(500).json({ error: err.message || '가입 신청 오류' }); }
});

// ── 회원: 내 상태 ──
router.get('/members/me', requireAuth, async (req, res) => {
  const m = await currentMember(req);
  res.json({ ok: true, member: m, approved: isApproved(m) });
});

// ── (관리자) 회원 승인/거절/여신한도 설정 ──
router.patch('/members/:id', requireAdmin, async (req, res) => {
  try {
    const allowed = ['status', 'credit_limit', 'company_name', 'ceo_name', 'biz_type', 'biz_item', 'address', 'tax_email'];
    const update = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (update.status === 'approved') update.approved_at = new Date().toISOString();
    const { data, error } = await supabase.from('b2b_members').update(update).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, member: data });
  } catch (err) { res.status(500).json({ error: err.message || '회원 수정 오류' }); }
});

// ════════════════════════════════════════════════════
//  게시판(판매글)
// ════════════════════════════════════════════════════

// 목록 — 공개범위(전체/선택업체/본인)만 노출 + 단가 가림
router.get('/listings', optionalAuth, async (req, res) => {
  try {
    const member = req.user ? await currentMember(req) : null;
    const { q, category, deal_type, post_kind, status = 'open', page = 1, limit = 20 } = req.query;
    const p = Number(page) || 1, l = Math.min(Number(limit) || 20, 50);
    let query = supabase.from('b2b_listings')
      .select('*, b2b_members(company_name, region:address)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((p - 1) * l, p * l - 1);
    if (status) query = query.eq('status', status);
    if (category) query = query.eq('category', category);
    if (deal_type) query = query.eq('deal_type', deal_type);
    if (post_kind) query = query.eq('post_kind', post_kind);
    if (q) query = query.ilike('item_name', `%${q}%`);
    // 공개범위: 회원이면 전체공개 ∪ 본인 ∪ 선택대상, 비회원이면 전체공개만 (비공개=초안은 항상 숨김)
    if (member) query = query.or(`visibility.eq.public,seller_id.eq.${member.id},and(visibility.eq.selected,allowed_members.cs.{${member.id}})`);
    else query = query.eq('visibility', 'public');
    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ ok: true, listings: (data || []).map(x => maskPrice(x, member)), total: count, page: p });
  } catch (err) { console.error('[b2b/listings]', err); res.status(500).json({ error: err.message || '목록 조회 오류' }); }
});

// 상세 — 공개범위 접근제어 + 단가 가림 + 조회수
router.get('/listings/:id', optionalAuth, async (req, res) => {
  try {
    const member = req.user ? await currentMember(req) : null;
    const { data, error } = await supabase.from('b2b_listings')
      .select('*, seller:b2b_members(id, company_name, ceo_name, biz_type, biz_item, address, contact_phone)')
      .eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ error: '게시글을 찾을 수 없습니다' });
    if (!canView(data, member)) return res.status(404).json({ error: '게시글을 찾을 수 없습니다' }); // 비공개/미대상
    supabase.from('b2b_listings').update({ view_count: (data.view_count || 0) + 1 }).eq('id', data.id).then(() => {});
    res.json({ ok: true, listing: maskPrice(data, member) });
  } catch (err) { res.status(500).json({ error: err.message || '상세 조회 오류' }); }
});

// 등록 (승인 회원만)
router.post('/listings', requireAuth, async (req, res) => {
  try {
    const m = await currentMember(req);
    if (!isApproved(m)) return res.status(403).json({ error: '승인된 B2B 회원만 등록할 수 있습니다', code: 'NOT_APPROVED' });
    const b = req.body || {};
    const kind = b.post_kind || 'sell'; // sell | buy_request | price_inquiry
    if (!b.title || !b.item_name) return res.status(400).json({ error: '제목·품목은 필수입니다' });
    if (kind === 'sell' && (!b.qty_total || !b.unit_price))
      return res.status(400).json({ error: '판매글은 수량·단가가 필수입니다' });
    const qty = Number(b.qty_total) || 0;
    const visibility = ['public', 'private', 'selected'].includes(b.visibility) ? b.visibility : 'public';
    const priceVis = ['public', 'inquiry', 'selected'].includes(b.price_visibility) ? b.price_visibility : 'public';
    const allowed = Array.isArray(b.allowed_members) ? b.allowed_members.map(Number).filter(Boolean) : [];
    const { data, error } = await supabase.from('b2b_listings').insert({
      seller_id: m.id, post_kind: kind, title: b.title, item_name: b.item_name, category: b.category || null,
      deal_type: b.deal_type || (kind === 'sell' ? 'surplus' : kind), qty_total: qty, qty_remaining: qty,
      unit: b.unit || 'kg', unit_price: Number(b.unit_price) || 0, origin: b.origin || null,
      expiry_at: b.expiry_at || null, storage: b.storage || null,
      delivery_type: b.delivery_type || null, delivery_info: b.delivery_info || null,
      region: b.region || null, description: b.description || null,
      images: Array.isArray(b.images) ? b.images : [], status: 'open',
      visibility, price_visibility: priceVis, allowed_members: allowed
    }).select().single();
    if (error) throw error;

    // ── 알림: 전체공개=전체 승인회원 / 선택업체=선택대상 / 비공개=없음 (본인 제외) ──
    try {
      let targets = [];
      if (visibility === 'public') {
        const { data: all } = await supabase.from('b2b_members').select('id').eq('status', 'approved').neq('id', m.id);
        targets = (all || []).map(x => x.id);
      } else if (visibility === 'selected') {
        const { data: appr } = await supabase.from('b2b_members').select('id').eq('status', 'approved').in('id', allowed.length ? allowed : [-1]);
        targets = (appr || []).map(x => x.id).filter(id => id !== m.id);
      }
      if (targets.length) {
        const kindLabel = kind === 'buy_request' ? '구매요청' : kind === 'price_inquiry' ? '단가문의' : '판매';
        await supabase.from('b2b_notifications').insert(targets.map(mid => ({
          member_id: mid, listing_id: data.id, type: 'new_listing',
          title: `[${kindLabel}] ${data.title}`, body: `${data.item_name} · ${m.company_name}`
        })));
      }
    } catch (e) { console.error('[b2b 알림 생성]', e.message); }

    res.status(201).json({ ok: true, listing: data });
  } catch (err) { console.error('[b2b/listings POST]', err); res.status(500).json({ error: err.message || '등록 오류' }); }
});

// 수정/마감 (본인 게시글만)
router.patch('/listings/:id', requireAuth, async (req, res) => {
  try {
    const m = await currentMember(req);
    const { data: own } = await supabase.from('b2b_listings').select('seller_id').eq('id', req.params.id).single();
    if (!own || !m || own.seller_id !== m.id) return res.status(403).json({ error: '본인 게시글만 수정할 수 있습니다' });
    const allowed = ['title', 'item_name', 'category', 'deal_type', 'qty_remaining', 'unit_price', 'origin',
      'expiry_at', 'storage', 'delivery_type', 'delivery_info', 'region', 'description', 'images', 'status'];
    const update = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const { data, error } = await supabase.from('b2b_listings').update(update).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, listing: data });
  } catch (err) { res.status(500).json({ error: err.message || '수정 오류' }); }
});

// ════════════════════════════════════════════════════
//  거래 (구매요청 → 수락 → 정산) + 여신
// ════════════════════════════════════════════════════

// 구매요청 (승인 회원, 여신 한도 사전확인)
router.post('/deals', requireAuth, async (req, res) => {
  try {
    const buyer = await currentMember(req);
    if (!isApproved(buyer)) return res.status(403).json({ error: '승인된 B2B 회원만 거래할 수 있습니다', code: 'NOT_APPROVED' });

    const { listing_id, qty } = req.body || {};
    const { data: listing } = await supabase.from('b2b_listings').select('*').eq('id', listing_id).single();
    if (!listing || listing.status !== 'open') return res.status(400).json({ error: '거래 가능한 게시글이 아닙니다' });
    if ((listing.post_kind || 'sell') !== 'sell') return res.status(400).json({ error: '구매요청·단가문의 글은 직접 거래 대상이 아닙니다. 게시자 연락처로 제안/문의하세요' });
    if (listing.seller_id === buyer.id) return res.status(400).json({ error: '본인 게시글은 구매할 수 없습니다' });
    const q = Number(qty);
    if (!q || q <= 0) return res.status(400).json({ error: '수량을 입력해주세요' });
    if (q > Number(listing.qty_remaining)) return res.status(400).json({ error: `남은 수량(${listing.qty_remaining}${listing.unit})을 초과했습니다` });

    // 계약단가 엔진 적용: 이 거래처(buyer)에 계약단가/등급단가가 있으면 그 가격으로 거래
    const quote = await resolvePrice({
      sellerId: listing.seller_id, buyerId: buyer.id, itemName: listing.item_name,
      qty: q, basePrice: Number(listing.unit_price), grade: buyer.grade || 'basic'
    });
    const appliedPrice = quote.price != null ? Number(quote.price) : Number(listing.unit_price);
    const tierLabel = { contract: '계약단가', grade: '등급단가', base: '기본단가' }[quote.tier] || '기본단가';

    const supply = Math.round(q * appliedPrice);
    const vat = Math.round(supply * VAT_RATE);
    const total = supply + vat;

    // 여신 한도 사전확인
    if ((Number(buyer.credit_used) + total) > Number(buyer.credit_limit)) {
      return res.status(400).json({ error: '여신 한도를 초과합니다. 관리자에게 한도 상향을 문의하세요', code: 'CREDIT_EXCEEDED',
        credit_limit: buyer.credit_limit, credit_used: buyer.credit_used, need: total });
    }

    const { data: deal, error } = await supabase.from('b2b_deals').insert({
      deal_no: dealNo(), listing_id: listing.id, seller_id: listing.seller_id, buyer_id: buyer.id,
      item_name: listing.item_name, qty: q, unit: listing.unit, unit_price: appliedPrice,
      supply_amount: supply, vat, total_amount: total, pay_method: 'credit',
      delivery_type: listing.delivery_type, delivery_info: listing.delivery_info,
      status: 'requested', note: (req.body.note || null) ? `${req.body.note} (${tierLabel})` : tierLabel + ' 적용'
    }).select().single();
    if (error) throw error;
    res.status(201).json({ ok: true, deal, price_tier: quote.tier, applied_price: appliedPrice });
  } catch (err) { console.error('[b2b/deals POST]', err); res.status(500).json({ error: err.message || '거래 요청 오류' }); }
});

// 내 거래 목록 (구매자/판매자 겸용)
router.get('/deals', requireAuth, async (req, res) => {
  try {
    const m = await currentMember(req);
    if (!m) return res.json({ ok: true, deals: [] });
    const role = req.query.role === 'seller' ? 'seller_id' : 'buyer_id';
    const { data, error } = await supabase.from('b2b_deals').select('*')
      .eq(role, m.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, deals: data || [] });
  } catch (err) { res.status(500).json({ error: err.message || '거래 조회 오류' }); }
});

// 거래 상태 변경 (판매자 수락/거절/배송, 정산)
//  accepted → 여신 미수 발생 + 재고 차감
//  settled  → 여신 상환
router.patch('/deals/:id/status', requireAuth, async (req, res) => {
  try {
    const m = await currentMember(req);
    const { status } = req.body;
    const { data: deal } = await supabase.from('b2b_deals').select('*').eq('id', req.params.id).single();
    if (!deal) return res.status(404).json({ error: '거래 없음' });
    const isSeller = m && deal.seller_id === m.id;
    const isBuyer = m && deal.buyer_id === m.id;
    if (!isSeller && !isBuyer) return res.status(403).json({ error: '권한 없음' });

    const sellerFlow = ['accepted', 'rejected', 'delivering', 'delivered'];
    if (sellerFlow.includes(status) && !isSeller) return res.status(403).json({ error: '판매자만 처리할 수 있습니다' });
    if (status === 'cancelled' && !(isBuyer && deal.status === 'requested')) return res.status(400).json({ error: '요청 상태의 거래만 구매자가 취소할 수 있습니다' });

    // accepted: 미수 발생 + 재고 차감
    if (status === 'accepted' && deal.status === 'requested') {
      const { data: buyer } = await supabase.from('b2b_members').select('credit_used, credit_limit').eq('id', deal.buyer_id).single();
      const newUsed = Number(buyer.credit_used) + Number(deal.total_amount);
      if (newUsed > Number(buyer.credit_limit)) return res.status(400).json({ error: '구매자 여신 한도 초과', code: 'CREDIT_EXCEEDED' });
      await supabase.from('b2b_members').update({ credit_used: newUsed, updated_at: new Date().toISOString() }).eq('id', deal.buyer_id);
      await supabase.from('b2b_credit_ledger').insert({ member_id: deal.buyer_id, deal_id: deal.id, entry_type: 'charge', amount: deal.total_amount, balance_after: newUsed, memo: `거래 ${deal.deal_no} 미수 발생` });
      const { data: lst } = await supabase.from('b2b_listings').select('qty_remaining').eq('id', deal.listing_id).single();
      const remain = Math.max(0, Number(lst?.qty_remaining || 0) - Number(deal.qty));
      await supabase.from('b2b_listings').update({ qty_remaining: remain, status: remain <= 0 ? 'soldout' : 'open', updated_at: new Date().toISOString() }).eq('id', deal.listing_id);
    }

    // settled: 미수 상환
    if (status === 'settled' && deal.status !== 'settled') {
      const { data: buyer } = await supabase.from('b2b_members').select('credit_used').eq('id', deal.buyer_id).single();
      const newUsed = Math.max(0, Number(buyer.credit_used) - Number(deal.total_amount));
      await supabase.from('b2b_members').update({ credit_used: newUsed, updated_at: new Date().toISOString() }).eq('id', deal.buyer_id);
      await supabase.from('b2b_credit_ledger').insert({ member_id: deal.buyer_id, deal_id: deal.id, entry_type: 'payment', amount: -Number(deal.total_amount), balance_after: newUsed, memo: `거래 ${deal.deal_no} 정산(상환)` });
    }

    const upd = { status, updated_at: new Date().toISOString() };
    if (status === 'settled') upd.settled_at = new Date().toISOString();
    const { data, error } = await supabase.from('b2b_deals').update(upd).eq('id', deal.id).select().single();
    if (error) throw error;
    res.json({ ok: true, deal: data });
  } catch (err) { console.error('[b2b/deals status]', err); res.status(500).json({ error: err.message || '상태 변경 오류' }); }
});

// ── 세금계산서 발행 (전자세금계산서 대행사 연동; 키 없으면 pending 기록) ──
router.post('/deals/:id/tax-invoice', requireAuth, async (req, res) => {
  try {
    const m = await currentMember(req);
    const { data: deal } = await supabase.from('b2b_deals').select('*').eq('id', req.params.id).single();
    if (!deal) return res.status(404).json({ error: '거래 없음' });
    if (!m || deal.seller_id !== m.id) return res.status(403).json({ error: '공급자(판매자)만 발행할 수 있습니다' });
    if (!['accepted', 'delivering', 'delivered', 'settled'].includes(deal.status))
      return res.status(400).json({ error: '수락된 거래만 세금계산서를 발행할 수 있습니다' });

    const { data: supplier } = await supabase.from('b2b_members').select('*').eq('id', deal.seller_id).single();
    const { data: buyer } = await supabase.from('b2b_members').select('*').eq('id', deal.buyer_id).single();

    // 기록 생성(pending) 후 대행사 발행 시도
    const { data: inv } = await supabase.from('b2b_tax_invoices').insert({
      deal_id: deal.id, supplier_id: deal.seller_id, buyer_id: deal.buyer_id,
      supply_amount: deal.supply_amount, vat: deal.vat, total_amount: deal.total_amount, status: 'pending'
    }).select().single();

    const result = await issueTaxInvoice({ deal, supplier, buyer });
    const upd = {
      provider: result.provider, provider_mgt_key: result.mgtKey || null,
      nts_confirm_no: result.ntsConfirmNo || null, pdf_url: result.pdfUrl || null,
      status: result.ok ? 'issued' : (result.pending ? 'pending' : 'failed'),
      issued_at: result.ok ? new Date().toISOString() : null,
      error_msg: result.error || null, updated_at: new Date().toISOString()
    };
    const { data: saved } = await supabase.from('b2b_tax_invoices').update(upd).eq('id', inv.id).select().single();
    res.json({ ok: result.ok, pending: !!result.pending, invoice: saved, message: result.message });
  } catch (err) { console.error('[b2b/tax-invoice]', err); res.status(500).json({ error: err.message || '세금계산서 처리 오류' }); }
});

// ════════════════════════════════════════════════════
//  계약단가 엔진 (거래처 계약 · 계약단가 · 단가조회)
// ════════════════════════════════════════════════════

// 거래처 계약 등록(판매자↔거래처). 이미 있으면 조건 갱신.
router.post('/contracts', requireAuth, async (req, res) => {
  try {
    const me = await currentMember(req);
    if (!isApproved(me)) return res.status(403).json({ error: '승인된 B2B 회원만 가능합니다', code: 'NOT_APPROVED' });
    const { buyer_id, payment_terms, moq, note, status } = req.body || {};
    if (!buyer_id || Number(buyer_id) === me.id) return res.status(400).json({ error: '거래처(구매자)를 선택해주세요' });
    const { data, error } = await supabase.from('b2b_contracts').upsert({
      seller_id: me.id, buyer_id: Number(buyer_id),
      payment_terms: payment_terms || null, moq: moq != null && moq !== '' ? Number(moq) : null,
      note: note || null, status: status || 'active', updated_at: new Date().toISOString()
    }, { onConflict: 'seller_id,buyer_id' }).select().single();
    if (error) throw error;
    res.status(201).json({ ok: true, contract: data });
  } catch (err) { console.error('[b2b/contracts POST]', err); res.status(500).json({ error: err.message || '계약 등록 오류' }); }
});

// 내 계약 목록 (기본 판매자 기준, ?role=buyer 이면 구매처로서)
router.get('/contracts', requireAuth, async (req, res) => {
  try {
    const me = await currentMember(req);
    if (!me) return res.json({ ok: true, contracts: [] });
    const asBuyer = req.query.role === 'buyer';
    const col = asBuyer ? 'buyer_id' : 'seller_id';
    const join = asBuyer ? 'seller:b2b_members!seller_id(id,company_name)'
                         : 'buyer:b2b_members!buyer_id(id,company_name)';
    const { data, error } = await supabase.from('b2b_contracts')
      .select(`*, ${join}`).eq(col, me.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, contracts: data || [] });
  } catch (err) { console.error('[b2b/contracts GET]', err); res.status(500).json({ error: err.message || '계약 조회 오류' }); }
});

// 계약단가 등록/수정(판매자)
router.post('/contract-prices', requireAuth, async (req, res) => {
  try {
    const me = await currentMember(req);
    if (!isApproved(me)) return res.status(403).json({ error: '승인된 B2B 회원만 가능합니다' });
    const b = req.body || {};
    if (!b.buyer_id || !b.item_name || b.unit_price == null || b.unit_price === '')
      return res.status(400).json({ error: '거래처·품목·단가는 필수입니다' });
    const { data, error } = await supabase.from('b2b_contract_prices').insert({
      seller_id: me.id, buyer_id: Number(b.buyer_id), item_name: b.item_name, category: b.category || null,
      unit_price: Number(b.unit_price), min_qty: Number(b.min_qty) || 0,
      valid_from: b.valid_from || null, valid_to: b.valid_to || null, active: true
    }).select().single();
    if (error) throw error;
    res.status(201).json({ ok: true, price: data });
  } catch (err) { console.error('[b2b/contract-prices POST]', err); res.status(500).json({ error: err.message || '계약단가 등록 오류' }); }
});

// 계약단가 목록(판매자: ?buyer_id= / 구매자: ?role=buyer 로 내게 적용된 단가)
router.get('/contract-prices', requireAuth, async (req, res) => {
  try {
    const me = await currentMember(req);
    if (!me) return res.json({ ok: true, prices: [] });
    let q = supabase.from('b2b_contract_prices').select('*').eq('active', true).order('created_at', { ascending: false });
    if (req.query.role === 'buyer') q = q.eq('buyer_id', me.id);
    else { q = q.eq('seller_id', me.id); if (req.query.buyer_id) q = q.eq('buyer_id', Number(req.query.buyer_id)); }
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, prices: data || [] });
  } catch (err) { res.status(500).json({ error: err.message || '계약단가 조회 오류' }); }
});

router.delete('/contract-prices/:id', requireAuth, async (req, res) => {
  try {
    const me = await currentMember(req);
    const { data: own } = await supabase.from('b2b_contract_prices').select('seller_id').eq('id', req.params.id).single();
    if (!own || !me || own.seller_id !== me.id) return res.status(403).json({ error: '본인 단가만 삭제할 수 있습니다' });
    await supabase.from('b2b_contract_prices').update({ active: false }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message || '삭제 오류' }); }
});

// 단가 조회(엔진) — 현재 로그인 구매자 기준 적용단가
router.get('/price-quote', requireAuth, async (req, res) => {
  try {
    const me = await currentMember(req);
    const { seller_id, item_name, qty, base } = req.query;
    const r = await resolvePrice({
      sellerId: Number(seller_id) || null, buyerId: me ? me.id : null, itemName: item_name || null,
      qty: Number(qty) || 0, basePrice: base != null ? Number(base) : null, grade: (me && me.grade) || 'basic'
    });
    res.json({ ok: true, ...r });
  } catch (err) { res.status(500).json({ error: err.message || '단가 조회 오류' }); }
});

// ── 선택업체 공개용: 승인 회원 목록(피커) ──
router.get('/members-list', requireAuth, async (req, res) => {
  try {
    const me = await currentMember(req);
    if (!isApproved(me)) return res.status(403).json({ error: '승인된 B2B 회원만 조회할 수 있습니다' });
    const { data } = await supabase.from('b2b_members').select('id, company_name')
      .eq('status', 'approved').neq('id', me.id).order('company_name');
    res.json({ ok: true, members: data || [] });
  } catch (err) { res.status(500).json({ error: err.message || '조회 오류' }); }
});

// ── 내 알림 (앱 내) ──
router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const m = await currentMember(req);
    if (!m) return res.json({ ok: true, notifications: [], unread: 0 });
    const { data } = await supabase.from('b2b_notifications').select('*')
      .eq('member_id', m.id).order('created_at', { ascending: false }).limit(50);
    res.json({ ok: true, notifications: data || [], unread: (data || []).filter(n => !n.is_read).length });
  } catch (err) { res.status(500).json({ error: err.message || '알림 조회 오류' }); }
});
router.patch('/notifications/read', requireAuth, async (req, res) => {
  try {
    const m = await currentMember(req);
    if (m) await supabase.from('b2b_notifications').update({ is_read: true }).eq('member_id', m.id).eq('is_read', false);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message || '처리 오류' }); }
});

// ── (관리자) B2B 회원 전체 목록 — 승인 관리용 ──
router.get('/admin/members', requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let q = supabase.from('b2b_members').select('*').order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, members: data || [] });
  } catch (err) { console.error('[b2b/admin/members]', err); res.status(500).json({ error: err.message || '회원 목록 오류' }); }
});

module.exports = router;
