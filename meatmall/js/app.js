/* ═══════════════════════════════════════════════════════════
   정육본가 — 공통 JS 유틸리티
═══════════════════════════════════════════════════════════ */

// ── 앱 상태 (간단한 중앙 스토어) ──────────────────────────
const Store = {
  user: null,          // { id, name, email, phone, grade, point }
  cart: [],            // [{ productId, name, price, qty, option }]
  wishlist: [],        // [productId, ...]
  notifications: 2,

  // localStorage 연동
  load() {
    try {
      this.user      = JSON.parse(localStorage.getItem('mm_user') || 'null');
      this.cart      = JSON.parse(localStorage.getItem('mm_cart') || '[]');
      this.wishlist  = JSON.parse(localStorage.getItem('mm_wishlist') || '[]');
    } catch(e) {}
  },
  save() {
    localStorage.setItem('mm_user',     JSON.stringify(this.user));
    localStorage.setItem('mm_cart',     JSON.stringify(this.cart));
    localStorage.setItem('mm_wishlist', JSON.stringify(this.wishlist));
  },

  // 장바구니
  addToCart(item) {
    const idx = this.cart.findIndex(c => c.productId === item.productId && c.option === item.option);
    if (idx > -1) this.cart[idx].qty += item.qty;
    else this.cart.push({...item});
    this.save();
    updateCartBadge();
  },
  cartCount() { return this.cart.reduce((s, c) => s + c.qty, 0); },

  // 찜
  toggleWish(pid) {
    const i = this.wishlist.indexOf(pid);
    if (i > -1) this.wishlist.splice(i, 1);
    else this.wishlist.push(pid);
    this.save();
  },
  isWished(pid) { return this.wishlist.includes(pid); },

  // 로그아웃
  logout() {
    this.user = null;
    localStorage.removeItem('mm_user');
    localStorage.removeItem('mm_addresses');
    toast('로그아웃 되었습니다');
  }
};

// ── 토스트 메시지 ────────────────────────────────────────
function toast(msg, duration = 2200) {
  let el = document.getElementById('toast-global');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-global';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), duration);
}

// ── 장바구니 배지 업데이트 ──────────────────────────────
function updateCartBadge() {
  const cnt = Store.cartCount();
  document.querySelectorAll('.cart-badge').forEach(el => {
    el.textContent = cnt;
    el.style.display = cnt > 0 ? 'flex' : 'none';
  });
}

// ── 숫자 포맷 ────────────────────────────────────────────
function fmt(n) { return Number(n).toLocaleString('ko-KR'); }
function fmtDate(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')}`;
}

// ── 바텀시트 헬퍼 ────────────────────────────────────────
function openSheet(sheetId, overlayId) {
  document.getElementById(overlayId).classList.add('open');
  document.getElementById(sheetId).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSheet(sheetId, overlayId) {
  document.getElementById(overlayId).classList.remove('open');
  document.getElementById(sheetId).classList.remove('open');
  document.body.style.overflow = '';
}

// ── 페이지 이동 ──────────────────────────────────────────
function go(url) { window.location.href = url; }

// ── 공통 헤더 HTML ───────────────────────────────────────
function renderHeader({ title = '정육본가', showBack = false, showSearch = true, showCart = true, showNotif = true } = {}) {
  const cartCnt = Store.cartCount();
  return `
  <header class="header">
    ${showBack
      ? `<button class="header__icon-btn" onclick="history.back()">←</button>`
      : `<div class="header__logo"><span>🥩</span>${title}</div>`}
    <div class="header__actions">
      ${showSearch ? `<button class="header__icon-btn" onclick="go('pages/search.html')">🔍</button>` : ''}
      ${showNotif ? `<button class="header__icon-btn" onclick="go('pages/notifications.html')">
        🔔<span class="badge" id="notif-badge">${Store.notifications}</span>
      </button>` : ''}
      ${showCart ? `<button class="header__icon-btn" onclick="go('pages/cart.html')">
        🛒<span class="badge cart-badge" style="display:${cartCnt>0?'flex':'none'}">${cartCnt}</span>
      </button>` : ''}
    </div>
  </header>`;
}

// ── 공통 하단 내비 HTML ──────────────────────────────────
function renderBottomNav(active = 'home') {
  const items = [
    { id: 'home',      icon: '🏠', label: '홈',     url: '../index.html' },
    { id: 'category',  icon: '📦', label: '카테고리', url: 'pages/category.html' },
    { id: 'subscribe', icon: '🔄', label: '정기배송', url: 'pages/subscribe.html' },
    { id: 'mypage',    icon: '👤', label: '마이',    url: 'pages/mypage.html' },
    { id: 'cs',        icon: '💬', label: 'CS',      url: 'pages/cs.html' },
  ];
  return `<nav class="bottom-nav">
    ${items.map(it => `
      <div class="nav-item ${it.id === active ? 'active' : ''}" onclick="go('${it.url}')">
        <span class="nav-icon">${it.icon}</span>
        <span>${it.label}</span>
      </div>`).join('')}
  </nav>`;
}

// ── 상품 카드 렌더 ────────────────────────────────────────
function renderProductCard(p) {
  const wished = Store.isWished(p.id);
  return `
  <div class="product-card" onclick="go('pages/product.html?id=${p.id}')">
    <div class="product-thumb">
      <div class="product-thumb-placeholder">${p.emoji || '🥩'}</div>
      <button class="product-like-btn" onclick="event.stopPropagation(); toggleWish(${p.id}, this)">
        ${wished ? '❤️' : '🤍'}
      </button>
      ${p.badge ? `<div style="position:absolute;top:8px;left:8px;">${p.badge.map(b=>`<span class="tag tag-${b.type}">${b.text}</span>`).join('')}</div>` : ''}
    </div>
    <div class="product-info">
      <div class="product-tags">${(p.tags||[]).map(t=>`<span class="tag tag-gray">${t}</span>`).join('')}</div>
      <div class="product-name">${p.name}</div>
      <div class="product-weight">${p.weight || ''}</div>
      <div class="product-price-wrap">
        ${p.originPrice ? `<span class="product-origin-price">${fmt(p.originPrice)}원</span>` : ''}
        ${p.discount ? `<span class="product-discount">${p.discount}%</span>` : ''}
      </div>
      <div class="product-price">${fmt(p.price)}원</div>
    </div>
  </div>`;
}

function toggleWish(pid, btn) {
  Store.toggleWish(pid);
  btn.textContent = Store.isWished(pid) ? '❤️' : '🤍';
  toast(Store.isWished(pid) ? '찜 목록에 추가했어요' : '찜 목록에서 제거했어요');
}

// ── 초기화 ───────────────────────────────────────────────
Store.load();

// ── 관리자 버튼 자동 표시 ──────────────────────────────
function showAdminBtn() {
  const user = JSON.parse(localStorage.getItem('mm_user_cache') || '{}');
  if (user.is_admin) {
    const btn = document.getElementById('admin-btn');
    if (btn) btn.style.display = 'flex';
  }
}
// DOM 로드 후 자동 실행
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', showAdminBtn);
} else {
  showAdminBtn();
}

// ── 상품 이미지 프리로드 (뷰포트 근접 2개만 — lazy loading 강화) ──
function preloadProductImages(products) {
  (products || []).slice(0, 2).forEach(p => {
    if (p.thumbnail_url) {
      const img = new Image();
      img.src = p.thumbnail_url;
    }
  });
}

// ── lazy 이미지 fade-in 초기화 ───────────────────────────
function initLazyImages() {
  document.querySelectorAll('img[loading="lazy"]').forEach(img => {
    if (img.complete && img.naturalWidth > 0) return;
    img.style.opacity = '0';
    img.style.transition = 'opacity .3s ease';
    img.addEventListener('load',  () => { img.style.opacity = '1'; }, { once: true });
    img.addEventListener('error', () => { img.style.opacity = '1'; }, { once: true });
  });
}

// ── BFCache(뒤로가기 캐시) 방지 ────────────────────────────
// 뒤로가기 시 페이지가 캐시에서 복원되면 강제 새로고침
window.addEventListener('pageshow', function(e) {
  if (e.persisted) {
    // BFCache에서 복원된 경우 → 강제 새로고침
    window.location.reload();
  }
});

// ── 이미지 메모리 캐시 ───────────────────────────────────
const _imgCache = new Map();
window.getCachedImage = (url) => {
  if (!url) return null;
  if (!_imgCache.has(url)) _imgCache.set(url, url);
  return _imgCache.get(url);
};
