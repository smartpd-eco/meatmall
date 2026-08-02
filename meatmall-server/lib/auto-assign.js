const supabase = require('./supabase');
const { evalCapacity } = require('./vendor-capacity');
// 레이어2(특허): 가공여력 기반 출고거점 선정 — 기본 OFF(플래그 ON일 때만 동작, 기존 무영향)
const CAPACITY_ON = process.env.VENDOR_CAPACITY_ROUTING === 'true' || process.env.VENDOR_CAPACITY_ROUTING === '1';

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceScore(distKm) {
  if (distKm <= 1) return 40;
  if (distKm <= 2) return 35;
  if (distKm <= 3) return 28;
  if (distKm <= 5) return 18;
  return 5;
}

// -1 = 배정 제외
function stockScore(currentStock, safetyStock, orderQty) {
  if (currentStock < orderQty) return -1;
  const ratio = currentStock / orderQty;
  if (ratio >= 3) return 30;
  if (ratio >= 2) return 25;
  if (ratio >= 1.5) return 18;
  return 10;
}

// -1 = 배정 제외
function loadScore(todayOrders, maxDailyOrders) {
  const rate = todayOrders / (maxDailyOrders || 50);
  if (rate > 0.9) return -1;
  if (rate <= 0.3) return 20;
  if (rate <= 0.5) return 16;
  if (rate <= 0.7) return 10;
  return 4;
}

function ratingScore(score) {
  return Math.round((score || 0) * 2 * 10) / 10;
}

async function findBestVendor(supabaseClient, zoneId, orderQty, productId) {
  const { data: vendorZones, error } = await supabaseClient
    .from('vendor_zones')
    .select('vendor_id, priority, max_daily_orders, vendors(id, vendor_name, lat, lng, score, is_active)')
    .eq('zone_id', zoneId)
    .order('priority', { ascending: true });

  if (error || !vendorZones?.length) return null;

  const { data: zone } = await supabaseClient
    .from('delivery_zones')
    .select('*')
    .eq('id', zoneId)
    .single();

  const today = new Date().toISOString().slice(0, 10);

  let best = null;
  let bestScore = -1;

  for (const vz of vendorZones) {
    const vendor = vz.vendors;
    if (!vendor || !vendor.is_active) continue;

    const { count: todayOrders } = await supabaseClient
      .from('order_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('vendor_id', vendor.id)
      .gte('assigned_at', today);

    const { data: inv } = await supabaseClient
      .from('vendor_inventory')
      .select('current_stock, safety_stock')
      .eq('vendor_id', vendor.id)
      .eq('product_id', productId)
      .single();

    const currentStock = inv?.current_stock ?? 0;

    const distKm =
      zone && vendor.lat && vendor.lng
        ? haversine(zone.lat || 0, zone.lng || 0, vendor.lat, vendor.lng)
        : 5;

    const ds = distanceScore(distKm);
    const ss = stockScore(currentStock, inv?.safety_stock ?? 5, orderQty);
    const ls = loadScore(todayOrders || 0, vz.max_daily_orders || 50);
    const rs = ratingScore(vendor.score);

    if (ss < 0 || ls < 0) continue;

    // ── 레이어2(특허): 가공여력 평가 (플래그 OFF면 미적용, 기존과 동일) ──
    let capScore = 0, capAvail = null;
    if (CAPACITY_ON) {
      let vc = {};
      const { data: vcRow, error: vcErr } = await supabaseClient
        .from('vendors')
        .select('same_day_cutoff, daily_order_limit, avg_prep_min, prep_parallel')
        .eq('id', vendor.id).single();
      if (!vcErr && vcRow) vc = vcRow;
      const cap = evalCapacity({ ...vc, todayCount: todayOrders || 0 });
      if (cap.exclude) continue;   // 마감 내 처리불가 → 배정 제외(실시간 재배정)
      capScore = cap.score; capAvail = cap.available;
    }

    const total = ds + ss + ls + rs + capScore;
    if (total > bestScore) {
      bestScore = total;
      best = {
        vendor_id: vendor.id,
        vendor_name: vendor.vendor_name,
        total_score: total,
        breakdown: {
          dist_score: ds,
          stock_score: ss,
          load_score: ls,
          rating_score: rs,
          capacity_score: capScore,
          capacity_available: capAvail,
          dist_km: Math.round(distKm * 10) / 10
        }
      };
    }
  }

  return best;
}

module.exports = { haversine, distanceScore, stockScore, loadScore, ratingScore, findBestVendor };
