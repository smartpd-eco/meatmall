const express = require('express');
const router = express.Router();
const supabase = require('../../lib/supabase');
const { requireAdmin } = require('../../middleware/auth');

// 인메모리 설정 캐시 (60초)
let _settingsCache = null;
let _settingsCacheAt = 0;
const SETTINGS_TTL = 60 * 1000;

const DEFAULT_SETTINGS = {
  enabled: true,
  position: 'bottom-right',
  opacity: 0.6,
  show_toast: true
};

const VALID_EVENTS = ['install_click', 'install_success', 'install_cancel'];

// ════════════════════════════════════════════════════
// GET /api/pwa/settings — 플로팅 버튼 설정 (공개)
// ════════════════════════════════════════════════════
router.get('/settings', async (req, res) => {
  try {
    if (_settingsCache && Date.now() - _settingsCacheAt < SETTINGS_TTL) {
      return res.json({ success: true, settings: _settingsCache });
    }
    const { data, error } = await supabase
      .from('pwa_settings')
      .select('enabled, position, opacity, show_toast')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw error;

    const settings = data ? {
      enabled: data.enabled,
      position: data.position || DEFAULT_SETTINGS.position,
      opacity: Number(data.opacity ?? DEFAULT_SETTINGS.opacity),
      show_toast: data.show_toast
    } : DEFAULT_SETTINGS;

    _settingsCache = settings;
    _settingsCacheAt = Date.now();
    res.json({ success: true, settings });
  } catch (err) {
    console.error('[pwa/settings GET]', err);
    // 설정 조회 실패 시에도 기본값 반환 (프론트 동작 보장)
    res.json({ success: true, settings: DEFAULT_SETTINGS });
  }
});

// ════════════════════════════════════════════════════
// PUT /api/pwa/settings — 설정 저장 (관리자)
// body: { enabled, position, opacity, show_toast }
// ════════════════════════════════════════════════════
router.put('/settings', requireAdmin, async (req, res) => {
  try {
    const { enabled, position, opacity, show_toast } = req.body;

    const patch = { id: 1, updated_at: new Date().toISOString() };
    if (typeof enabled === 'boolean') patch.enabled = enabled;
    if (typeof show_toast === 'boolean') patch.show_toast = show_toast;
    if (position && ['bottom-right', 'bottom-left'].includes(position)) patch.position = position;
    if (opacity !== undefined) {
      const op = Number(opacity);
      if (isNaN(op) || op < 0.2 || op > 1) {
        return res.status(400).json({ success: false, message: '투명도는 0.2~1.0 사이여야 합니다' });
      }
      patch.opacity = op;
    }

    const { data, error } = await supabase
      .from('pwa_settings')
      .upsert([patch], { onConflict: 'id' })
      .select();
    if (error) throw error;

    _settingsCache = null; // 캐시 무효화
    res.json({ success: true, settings: data[0] });
  } catch (err) {
    console.error('[pwa/settings PUT]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════
// POST /api/pwa/track — 설치 이벤트 수집 (공개)
// body: { event_type, browser, os, device_type }
// ════════════════════════════════════════════════════
router.post('/track', async (req, res) => {
  try {
    const { event_type, browser, os, device_type } = req.body;
    if (!VALID_EVENTS.includes(event_type)) {
      return res.status(400).json({ success: false, message: '유효하지 않은 이벤트입니다' });
    }
    const clean = v => (typeof v === 'string' ? v.slice(0, 30) : null);

    const { error } = await supabase.from('pwa_install_logs').insert([{
      event_type,
      browser: clean(browser),
      os: clean(os),
      device_type: ['mobile', 'desktop'].includes(device_type) ? device_type : null
    }]);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('[pwa/track POST]', err);
    res.status(500).json({ success: false });
  }
});

// ════════════════════════════════════════════════════
// GET /api/pwa/stats — 설치 통계 (관리자)
// ════════════════════════════════════════════════════
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const dayAgo   = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo  = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: logs, error } = await supabase
      .from('pwa_install_logs')
      .select('event_type, browser, os, device_type, created_at')
      .gte('created_at', monthAgo)
      .order('created_at', { ascending: false })
      .limit(10000);
    if (error) throw error;

    const rows = logs || [];
    const count = (list, ev) => list.filter(l => l.event_type === ev).length;
    const inRange = since => rows.filter(l => l.created_at >= since);

    const today = inRange(dayAgo), week = inRange(weekAgo);

    const breakdown = key => {
      const map = {};
      rows.forEach(l => { const k = l[key] || '기타'; map[k] = (map[k] || 0) + 1; });
      return Object.entries(map)
        .sort((a, b) => b[1] - a[1])
        .map(([name, cnt]) => ({ name, count: cnt }));
    };

    const clicks = count(rows, 'install_click');
    const successes = count(rows, 'install_success');

    res.json({
      success: true,
      stats: {
        today:  { clicks: count(today, 'install_click'), installs: count(today, 'install_success'), cancels: count(today, 'install_cancel') },
        week:   { clicks: count(week, 'install_click'),  installs: count(week, 'install_success'),  cancels: count(week, 'install_cancel') },
        month:  { clicks, installs: successes, cancels: count(rows, 'install_cancel') },
        success_rate: clicks > 0 ? Math.round((successes / clicks) * 100) : 0,
        browsers: breakdown('browser'),
        os: breakdown('os'),
        devices: breakdown('device_type')
      }
    });
  } catch (err) {
    console.error('[pwa/stats GET]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
