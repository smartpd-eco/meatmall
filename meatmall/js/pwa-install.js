/* ════════════════════════════════════════════════════
   PWA 앱 설치 플로팅 버튼 (MD_031)
   - 로그인 페이지와 동일 아이콘(images/icon-192.png) 사용
   - 기본 투명도 60% / Hover 100%
   - 설치된 사용자 자동 숨김
   - 관리자 설정(ON/OFF·위치·투명도) API 연동
   - 설치 통계(install_click/success/cancel) 수집
   자체 완결형 스크립트 — 다른 파일 의존 없음
   ════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* PWA API는 git 연동 Vercel 프로젝트(meatmall) 사용 — push 시 자동 배포됨
     (meatmall-server 프로젝트는 CLI 배포 전용이라 /api/pwa 미반영) */
  var PWA_API = 'https://meatmall.vercel.app/api/pwa';
  var BASE = (location.pathname.indexOf('/pages/') > -1 || location.pathname.indexOf('/admin/') > -1)
    ? '../images/' : 'images/';
  var ICON = BASE + 'install-icon.png';          /* 새 공식 설치 아이콘 */
  var ICON_FALLBACK = BASE + 'icon-192.png';     /* 이미지 없을 때 기존 아이콘 */
  var SHARE_IMG = BASE + 'share-btn.png';        /* 공유하기 버튼 이미지 */
  var SHARE_URL = 'https://smartpd-eco.github.io/meatmall/';
  var LS_INSTALLED = 'mm-pwa-installed';
  var LS_TOAST     = 'mm-pwa-toast-v1';
  var LS_SETTINGS  = 'mm-pwa-settings';
  var SETTINGS_TTL = 10 * 60 * 1000; // 10분 캐시

  var DEFAULTS = { enabled: true, position: 'bottom-right', opacity: 0.6, show_toast: true, show_share: true };

  /* ── 이미 설치(standalone) 상태면 아무것도 하지 않음 ── */
  function isStandalone() {
    return window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }
  if (isStandalone()) { try { localStorage.setItem(LS_INSTALLED, '1'); } catch (e) {} }
  var IS_INSTALLED = isStandalone() || !!localStorage.getItem(LS_INSTALLED);   /* 설치됨/앱 실행 → 설치버튼만 숨김(공유는 유지) */

  /* ── 환경 감지 ── */
  var ua = navigator.userAgent;
  var isIOS     = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  var isAndroid = /Android/.test(ua);
  var isMobile  = isIOS || isAndroid;

  /* 인앱 브라우저 감지 (카카오/네이버/라인/인스타/페북 등 — beforeinstallprompt 미지원) */
  function isInApp() {
    return /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|DaumApps|; wv\)/i.test(ua);
  }

  function detectBrowser() {
    if (/Edg\//.test(ua)) return 'Edge';
    if (/SamsungBrowser/.test(ua)) return 'Samsung';
    if (/Whale/.test(ua)) return 'Whale';
    if (/CriOS|Chrome/.test(ua)) return 'Chrome';
    if (/FxiOS|Firefox/.test(ua)) return 'Firefox';
    if (/Safari/.test(ua)) return 'Safari';
    return 'Other';
  }
  function detectOS() {
    if (isIOS) return 'iOS';
    if (isAndroid) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Other';
  }

  /* ── 통계 전송 (실패해도 무시) ── */
  function track(event) {
    try {
      fetch(PWA_API + '/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: event,
          browser: detectBrowser(),
          os: detectOS(),
          device_type: isMobile ? 'mobile' : 'desktop'
        }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  /* ── beforeinstallprompt 캡처 (스크립트 로드 즉시 등록) ── */
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
  });

  window.addEventListener('appinstalled', function () {
    try { localStorage.setItem(LS_INSTALLED, '1'); } catch (e) {}
    track('install_success');
    hideButton();
    showMiniToast('🎉 설치가 완료되었습니다');
  });

  /* ── 관리자 설정 로드 (캐시 → API → 기본값) ── */
  function loadSettings(cb) {
    try {
      var cached = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
      if (cached && Date.now() - cached.t < SETTINGS_TTL) return cb(cached.v);
    } catch (e) {}
    fetch(PWA_API + '/settings')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var v = (d && d.settings) ? d.settings : DEFAULTS;
        try { localStorage.setItem(LS_SETTINGS, JSON.stringify({ t: Date.now(), v: v })); } catch (e) {}
        cb(v);
      })
      .catch(function () { cb(DEFAULTS); });
  }

  /* ── 스타일 주입 ── */
  function injectCSS(op) {
    var css = [
      '#mm-pwa-stack{position:fixed;z-index:900;display:flex;flex-direction:column;align-items:flex-end;gap:10px}',
      '.mm-pwa-btn{position:relative;background:none;border:none;padding:0;cursor:pointer;opacity:' + op + ';',
      'border-radius:16px;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,.45);',
      'transition:opacity .2s,transform .2s;-webkit-tap-highlight-color:transparent}',
      '.mm-pwa-btn img{width:56px;height:56px;display:block;object-fit:cover}',
      '.mm-pwa-btn .mm-lbl{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      'color:#fff;font-size:.7rem;font-weight:800;letter-spacing:.02em;background:rgba(15,15,15,.55);',
      'opacity:0;transition:opacity .2s;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.7)}',
      '.mm-pwa-btn:hover,.mm-pwa-btn:focus-visible{opacity:1;transform:scale(1.05);outline:none}',
      '.mm-pwa-btn:hover .mm-lbl,.mm-pwa-btn:focus-visible .mm-lbl{opacity:1}',
      '.mm-pwa-btn:active{opacity:1}',
      '.mm-pwa-btn.mm-bounce{animation:mmPwaBounce .15s ease}',
      '@keyframes mmPwaBounce{0%{transform:scale(1)}50%{transform:scale(.92)}100%{transform:scale(1.05)}}',
      '@media(max-width:640px){.mm-pwa-btn img{width:48px;height:48px}.mm-pwa-btn{border-radius:14px}}',
      /* 설치 안내 모달 */
      '#mm-pwa-guide{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.66);display:flex;align-items:flex-end;justify-content:center}',
      '@media(min-width:641px){#mm-pwa-guide{align-items:center}}',
      '#mm-pwa-guide .mm-sheet{background:#1A1A1A;border:1px solid rgba(201,168,76,.4);border-radius:14px 14px 0 0;',
      'max-width:420px;width:100%;padding:22px 20px 26px;color:#F0F2F5;font-size:.86rem;line-height:1.75}',
      '@media(min-width:641px){#mm-pwa-guide .mm-sheet{border-radius:14px}}',
      '#mm-pwa-guide .mm-sheet h3{color:#C9A84C;font-size:.95rem;margin:0 0 10px;display:flex;align-items:center;gap:8px}',
      '#mm-pwa-guide .mm-sheet ol{margin:0 0 14px;padding-left:20px;color:#D1D5DB}',
      '#mm-pwa-guide .mm-go{width:100%;height:46px;background:linear-gradient(135deg,#C9A84C,#E8C97A);border:none;',
      'color:#111;border-radius:8px;font-size:.9rem;font-weight:800;cursor:pointer;margin-bottom:8px}',
      '#mm-pwa-guide .mm-close{width:100%;height:42px;background:transparent;border:1px solid rgba(201,168,76,.4);',
      'color:#C9A84C;border-radius:8px;font-size:.85rem;font-weight:700;cursor:pointer}',
      /* 미니 토스트 */
      '#mm-pwa-toast{position:fixed;left:50%;transform:translateX(-50%) translateY(8px);bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:1300;',
      'background:#1A1A1A;border:1px solid rgba(201,168,76,.45);color:#E8C97A;font-size:.8rem;font-weight:600;',
      'padding:10px 18px;border-radius:999px;box-shadow:0 4px 18px rgba(0,0,0,.5);opacity:0;transition:opacity .3s,transform .3s;pointer-events:none;max-width:88vw;text-align:center}',
      '#mm-pwa-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}'
    ].join('');
    var s = document.createElement('style');
    s.id = 'mm-pwa-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ── 위치 계산 (모바일은 하단 네비 위로) ── */
  function applyPosition(btn, pos) {
    var hasNav = !!document.querySelector('.nav');
    var bottomMobile = hasNav ? '78px' : '16px';
    var side = (pos === 'bottom-left') ? 'left' : 'right';
    btn.style[side] = isMobile ? '16px' : '24px';
    btn.style.bottom = isMobile ? bottomMobile : '24px';
  }

  /* ── 플로팅 스택 생성: [공유하기] 위 + [앱 설치] 아래 ── */
  var fab = null, stack = null, shareBtn = null;
  function createButton(settings) {
    stack = document.createElement('div');
    stack.id = 'mm-pwa-stack';
    applyPosition(stack, settings.position);

    function mkBtn(id, src, fallback, label, onClick) {
      var b = document.createElement('button');
      b.id = id; b.type = 'button';
      b.className = 'mm-pwa-btn';
      b.setAttribute('aria-label', '정육본가 ' + label);
      var im = document.createElement('img');
      im.src = src; im.alt = '';
      im.setAttribute('aria-hidden', 'true');
      if (fallback) im.onerror = function () { im.onerror = null; im.src = fallback; };
      var lb = document.createElement('span');
      lb.className = 'mm-lbl'; lb.textContent = label;   /* 마우스 오버 시 중앙 표시 */
      b.appendChild(im); b.appendChild(lb);
      b.addEventListener('click', onClick);
      return b;
    }

    if (settings.show_share !== false) {
      shareBtn = mkBtn('mm-pwa-share', SHARE_IMG, ICON_FALLBACK, '공유하기', onShareClick);
      stack.appendChild(shareBtn);
    }

    if (!IS_INSTALLED) {
      fab = mkBtn('mm-pwa-fab', ICON, ICON_FALLBACK, '설치하기', onInstallClick);
      stack.appendChild(fab);
    }

    if (stack.childNodes.length) document.body.appendChild(stack);
  }

  function hideButton() {
    if (fab && fab.parentNode) fab.parentNode.removeChild(fab);
    fab = null;
    if (stack && !shareBtn) { if (stack.parentNode) stack.parentNode.removeChild(stack); stack = null; }
  }

  /* ── 공유하기: 모바일=네이티브 공유시트 / PC=링크 복사 ── */
  function onShareClick() {
    track('share_click');
    if (navigator.share) {
      navigator.share({ title: '정육본가 — 프리미엄 정육', text: '주인장이 직접 고른 프리미엄 정육, 정육본가', url: SHARE_URL }).catch(function () {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(SHARE_URL).then(function () { showMiniToast('🔗 링크가 복사되었습니다'); }).catch(function () {});
    }
  }

  /* ── 네이티브 설치 다이얼로그 실행 ── */
  function promptInstall() {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function (choice) {
      if (choice.outcome !== 'accepted') track('install_cancel');
      /* accepted 성공 카운트는 appinstalled 이벤트에서 기록 */
      deferredPrompt = null;
    });
  }

  /* ── 클릭 → 즉시 설치 (이벤트 지연 시 최대 3초 대기 후 안내로 폴백) ── */
  function onInstallClick() {
    if (!fab) return;
    fab.classList.add('mm-bounce');
    setTimeout(function () { fab && fab.classList.remove('mm-bounce'); }, 200);
    track('install_click');

    if (deferredPrompt) { promptInstall(); return; }

    /* beforeinstallprompt가 아직 안 온 경우(접속 직후 클릭) 잠시 대기 */
    var waited = 0;
    var iv = setInterval(function () {
      waited += 250;
      if (deferredPrompt) { clearInterval(iv); promptInstall(); }
      else if (waited >= 3000) { clearInterval(iv); showGuide(); }
    }, 250);
  }

  /* ── 설치 방법 안내 (beforeinstallprompt 미지원 환경) ── */
  function showGuide() {
    var steps, primaryBtn = '', openChrome = false;

    if (isInApp()) {
      /* 카카오/네이버 등 인앱 브라우저 → 여기선 설치 불가. Chrome으로 열기 유도 */
      steps = '<h3>📲 앱 설치하기</h3>' +
        '<p style="margin:0 0 4px">지금은 <strong>다른 앱 안의 브라우저</strong>로 열려 있어요.<br>' +
        'Chrome 등 기본 브라우저로 열면 <strong>버튼 한 번</strong>으로 설치됩니다.</p>';
      primaryBtn = '<button class="mm-go" type="button">Chrome으로 열기</button>';
      openChrome = true;
    } else if (isIOS) {
      steps = '<h3>📲 아이폰 설치 방법</h3><ol>' +
        '<li>Safari 하단의 <strong>공유 버튼</strong>(□↑)을 탭</li>' +
        '<li><strong>홈 화면에 추가</strong> 선택</li>' +
        '<li>우측 상단 <strong>추가</strong> 탭</li></ol>';
    } else if (isAndroid) {
      steps = '<h3>📲 안드로이드 설치 방법</h3><ol>' +
        '<li>Chrome 우측 상단 <strong>⋮ 메뉴</strong> 탭</li>' +
        '<li><strong>앱 설치</strong> 또는 <strong>홈 화면에 추가</strong> 선택</li></ol>';
    } else {
      steps = '<h3>📲 PC 설치 방법</h3><ol>' +
        '<li>주소창 우측의 <strong>설치 아이콘</strong>(⊕) 클릭</li>' +
        '<li><strong>설치</strong> 버튼 클릭</li></ol>';
    }

    var wrap = document.createElement('div');
    wrap.id = 'mm-pwa-guide';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', '앱 설치 안내');
    wrap.innerHTML = '<div class="mm-sheet">' + steps + primaryBtn +
      '<button class="mm-close" type="button">확인</button></div>';

    function close() { if (wrap.parentNode) wrap.remove(); }

    /* 안내창이 떠 있는 동안에도 설치 이벤트가 도착하면 즉시 설치 실행 */
    var poll = setInterval(function () {
      if (deferredPrompt) { clearInterval(poll); close(); promptInstall(); }
    }, 400);
    setTimeout(function () { clearInterval(poll); }, 8000);

    wrap.addEventListener('click', function (e) {
      var cls = e.target.className || '';
      if (openChrome && cls === 'mm-go') {
        clearInterval(poll);
        /* 안드로이드: Chrome 인텐트로 강제 오픈 (인앱 → Chrome 탈출) */
        if (isAndroid) {
          var host = location.host, path = location.pathname + location.search;
          location.href = 'intent://' + host + path + '#Intent;scheme=https;package=com.android.chrome;end';
        } else {
          window.open(SHARE_URL, '_blank');
        }
        return;
      }
      if (e.target === wrap || cls === 'mm-close') {
        clearInterval(poll);
        /* 확인 시점에 설치 이벤트가 있으면 바로 설치, 없으면 닫기 */
        if (deferredPrompt) { close(); promptInstall(); }
        else close();
      }
    });

    document.body.appendChild(wrap);
    var pf = wrap.querySelector('.mm-go') || wrap.querySelector('.mm-close');
    if (pf) pf.focus();
  }

  /* ── 미니 토스트 ── */
  function showMiniToast(msg) {
    var t = document.getElementById('mm-pwa-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'mm-pwa-toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); }, 3500);
  }

  /* ── 초기화 ── */
  function init() {
    loadSettings(function (settings) {
      if (settings.enabled === false) return;   /* 관리자 OFF */
      injectCSS(typeof settings.opacity === 'number' ? settings.opacity : 0.6);
      createButton(settings);

      /* 이미 이 기기에 설치되어 있으면 버튼 숨김 (지원 브라우저 한정) */
      if (navigator.getInstalledRelatedApps) {
        navigator.getInstalledRelatedApps().then(function (apps) {
          if (apps && apps.length) {
            try { localStorage.setItem(LS_INSTALLED, '1'); } catch (e) {}
            hideButton();
          }
        }).catch(function () {});
      }

      /* 첫 방문 5초 후 스마트 안내 토스트 (1회) */
      if (settings.show_toast !== false && !localStorage.getItem(LS_TOAST)) {
        setTimeout(function () {
          if (!fab) return;
          showMiniToast('📲 앱으로 설치하면 더 빠르게 이용할 수 있습니다');
          try { localStorage.setItem(LS_TOAST, '1'); } catch (e) {}
        }, 5000);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
