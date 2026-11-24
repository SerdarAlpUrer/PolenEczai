// ── SABİTLER VE KONUM ───────────────────────────────────────────────────────
const POLEN_LAT = 39.767564;
const POLEN_LON = 30.505898;
const PUBLIC_MOBILE_URL = 'https://serdaralpurer.github.io/PolenEczai/?mobil=1';
const EO_SOURCE_URL = 'https://www.eskisehireo.org.tr/eskisehir-nobetci-eczaneler/';
const JINA_LIVE_FAILOVER_URL = 'https://r.jina.ai/' + EO_SOURCE_URL;
const LIVE_CACHE_KEY = 'polenLiveCacheV3';

const RURAL_DISTRICTS = [
  'ALPU', 'BEYLİKOVA', 'BEYLIKOVA', 'ÇİFTELER', 'CIFTELER',
  'GÜNYÜZÜ', 'GUNYUZU', 'HAN', 'İNÖNÜ', 'INONU',
  'MAHMUDİYE', 'MAHMUDIYE', 'MİHALGAZİ', 'MIHALGAZI',
  'MİHALICÇIK', 'MIHALICCIK', 'SARICAKAYA', 'SEYİTGAZİ',
  'SEYITGAZI', 'SİVRİHİSAR', 'SIVRIHISAR'
];

// Mobil görünüm tespiti (?mobil=1 veya telefon ekranı)
const urlParams = new URLSearchParams(window.location.search);
const isMobileMode = urlParams.get('mobil') === '1' || window.innerWidth <= 900;
if (isMobileMode) {
  document.body.classList.add('is-mobile');
}

// Durum değişkenleri
let rawSchedulePool = [];      // Tüm çekilen vardiya havuzu (5 günlük takvim dahil)
let activePharmacies = [];     // Şu anki vardiyada aktif olan merkez eczaneler
let lastUpdatedIso = null;
let dataSourceMode = 'primary'; // 'api' | 'json' | 'live-failover' | 'stale-cache'
let currentDistrict = 'ALL';
let districtResetTimer = null;
let selectedPharmIndex = -1;

// ── TÜRKÇE BÜYÜK HARF YARDIMCISI ────────────────────────────────────────────
function trUpper(str) {
  return (str || '')
    .replace(/i/g, 'İ')
    .replace(/ı/g, 'I')
    .replace(/ğ/g, 'Ğ')
    .replace(/ü/g, 'Ü')
    .replace(/ş/g, 'Ş')
    .replace(/ö/g, 'Ö')
    .replace(/ç/g, 'Ç')
    .toUpperCase();
}

// ── SAAT ────────────────────────────────────────────────────────────────────
function tick() {
  const d = new Date();
  const t = d.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
  const s = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const clockEl = document.getElementById('clock');
  if (clockEl) {
    clockEl.innerHTML = `<div class="c-date">${t}</div><div class="c-time">${s}</div>`;
  }
}
tick();
setInterval(tick, 10000);

// ── QR ÜRETİCİ ──────────────────────────────────────────────────────────────
function makeQR(el, url, baseSize = 115) {
  if (!el || typeof QRCode === 'undefined') return;
  el.innerHTML = '';
  const size = window.innerWidth >= 1900 ? Math.round(baseSize * 1.75) : baseSize;
  try {
    new QRCode(el, {
      text: url,
      width: size,
      height: size,
      colorDark: '#0a0a0a',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch (e) {
    el.innerHTML = '<div style="font-size:9px;color:#555;padding:6px;text-align:center">QR yok</div>';
  }
}

function getTakeawayUrl() {
  const host = window.location.hostname;
  const isHttpsPublic = window.location.protocol === 'https:' && host && !host.startsWith('192.168.') && !host.startsWith('10.') && host !== 'localhost' && host !== '127.0.0.1';
  if (isHttpsPublic) {
    const base = window.location.origin + window.location.pathname.replace(/index\.html$/, '');
    return base.endsWith('/') ? `${base}?mobil=1` : `${base}/?mobil=1`;
  }
  return PUBLIC_MOBILE_URL;
}

// ── TARİH VE VARDİYA HESAPLAMA ──────────────────────────────────────────────
function parseShiftMs(dtStr, isoFallback) {
  if (isoFallback) {
    const t = Date.parse(isoFallback);
    if (!Number.isNaN(t)) return t;
  }
  if (!dtStr) return null;
  const m = dtStr.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  // Türkiye saati UTC+3 sabit
  const iso = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+03:00`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeDistrict(rawIlce, adText = '') {
  const combined = trUpper(`${rawIlce || ''} ${adText || ''}`);
  if (RURAL_DISTRICTS.some(r => combined.includes(r))) return { ilce: combined, isMerkez: false };
  if (combined.includes('ODUNPAZARI')) return { ilce: 'MERKEZ-ODUNPAZARI', short: 'Odunpazarı', isMerkez: true };
  if (combined.includes('TEPEBAŞI') || combined.includes('TEPEBASI')) return { ilce: 'MERKEZ-TEPEBAŞI', short: 'Tepebaşı', isMerkez: true };
  if (combined.includes('MERKEZ')) return { ilce: 'MERKEZ', short: 'Merkez', isMerkez: true };
  return { ilce: rawIlce || 'Bilinmiyor', short: rawIlce || '', isMerkez: false };
}

function formatPhoneDisplay(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const norm = digits.length === 10 ? '0' + digits : digits;
  if (norm.length === 11 && norm.startsWith('0')) {
    return `${norm.slice(0, 4)} ${norm.slice(4, 7)} ${norm.slice(7, 9)} ${norm.slice(9, 11)}`;
  }
  return String(raw || '').trim();
}

// ── YEDEK PARSERLAR (Eski HTML data.json veya Canlı Jina Markdown) ──────────
function parseLegacyHtml(htmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, 'text/html');
  const cards = doc.querySelectorAll('.nobetci, .nobetcig');
  const out = [];

  cards.forEach(kart => {
    const h4 = kart.querySelector('h4');
    if (!h4) return;
    h4.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    const rawH4 = (h4.textContent || '').trim();
    const blacklist = ['çerez ayarları', 'gizlilik', 'cerez', 'oben'];
    if (!rawH4 || blacklist.some(b => rawH4.toLowerCase().includes(b))) return;

    const lines = rawH4.split('\n').map(s => s.trim()).filter(Boolean);
    let joined = lines.join(' - ').replace(/\s+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '');
    let ad = joined;
    let rawIlce = '';

    if (joined.includes(' - ')) {
      const parts = joined.split(' - ').map(p => p.replace(/^[\s-]+|[\s-]+$/g, '')).filter(Boolean);
      if (parts.length >= 2) {
        ad = parts[0];
        rawIlce = parts.slice(1).join('-');
      }
    } else {
      const m = joined.match(/(ECZANES[İI])\s*[-–]?\s*(.+)$/i);
      if (m && m[2]) {
        ad = joined.slice(0, m.index + m[1].length).trim();
        rawIlce = m[2].trim();
      }
    }

    const dInfo = normalizeDistrict(rawIlce, ad);
    if (!dInfo.isMerkez) return;

    const fullText = (kart.textContent || '').replace(/\s+/g, ' ').trim();
    const mapLinkEl = kart.querySelector('a[href*="maps"]');
    const harita_link = mapLinkEl ? (mapLinkEl.getAttribute('href') || '') : '';
    const telLinkEl = kart.querySelector('a[href^="tel:"]');
    let telefon_raw = telLinkEl ? (telLinkEl.textContent || telLinkEl.getAttribute('href').slice(4)) : '';
    if (!telefon_raw) {
      const tm = fullText.match(/0\s*\d{3}\s*\d{3}\s*\d{2}\s*\d{2}/);
      if (tm) telefon_raw = tm[0];
    }
    telefon_raw = telefon_raw.replace(/\D/g, '');

    let lat = null, lon = null;
    const cm = harita_link.match(/q=([-\d.]+),([-\d.]+)/);
    if (cm) { lat = cm[1]; lon = cm[2]; }

    let nobet_baslangic = '', nobet_bitis = '';
    const sm = fullText.match(/(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})\s*\/\s*(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/);
    if (sm) { nobet_baslangic = sm[1].trim(); nobet_bitis = sm[2].trim(); }

    let adres = '';
    const pTag = kart.querySelector('p');
    if (pTag) {
      const pClone = pTag.cloneNode(true);
      pClone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
      const cleanLines = (pClone.textContent || '').split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(s => {
        if (!s) return false;
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return false;
        if (/\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/.test(s)) return false;
        if (/eczaneyi\s+haritada/i.test(s)) return false;
        if (/nöbetçidir/i.test(s)) return false;
        return true;
      });
      adres = cleanLines.join(' ').replace(/0\d{10}/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 220);
    }

    out.push({
      ad,
      ilce: dInfo.ilce,
      adres,
      telefon: formatPhoneDisplay(telefon_raw),
      telefon_raw,
      lat,
      lon,
      harita_link,
      nobet_baslangic,
      nobet_bitis
    });
  });

  return out;
}

function parseJinaMarkdown(mdText) {
  const blocks = String(mdText || '').split(/^####\s+/m).slice(1);
  const out = [];

  blocks.forEach(blk => {
    const lines = blk.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const header = lines[0].replace(/\*+/g, '').trim();
    let ad = header, rawIlce = '';
    if (header.includes(' - ')) {
      const parts = header.split(' - ').map(s => s.trim()).filter(Boolean);
      ad = parts[0];
      rawIlce = parts.slice(1).join('-');
    }
    const dInfo = normalizeDistrict(rawIlce, ad);
    if (!dInfo.isMerkez) return;

    const body = lines.slice(1).join('\n');
    const telM = body.match(/\(tel:([^)]+)\)/) || body.match(/(0\d{10})/);
    const telefon_raw = telM ? telM[1].replace(/\D/g, '') : '';
    const mapM = body.match(/\((https?:\/\/[^)\s]*maps[^)\s]*)/i);
    const harita_link = mapM ? mapM[1] : '';
    let lat = null, lon = null;
    const cm = harita_link.match(/q=([-\d.]+),([-\d.]+)/);
    if (cm) { lat = cm[1]; lon = cm[2]; }

    let nobet_baslangic = '', nobet_bitis = '';
    const sm = body.match(/(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})\s*\/\s*(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/);
    if (sm) { nobet_baslangic = sm[1].trim(); nobet_bitis = sm[2].trim(); }

    const addrLines = lines.slice(1).filter(ln => {
      if (ln.startsWith('![') || ln.startsWith('[') || ln.startsWith('* *')) return false;
      if (/\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/.test(ln)) return false;
      if (/nöbetçidir/i.test(ln)) return false;
      return true;
    });

    out.push({
      ad,
      ilce: dInfo.ilce,
      adres: addrLines.join(' ').replace(/0\d{10}/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 220),
      telefon: formatPhoneDisplay(telefon_raw),
      telefon_raw,
      lat,
      lon,
      harita_link,
      nobet_baslangic,
      nobet_bitis
    });
  });

  return out;
}

// ── AKTİF VARDİYAYI SEÇME (5 Günlük Takvimden Saniyesi Saniyesine Geçiş) ───
function selectCurrentShiftPharmacies(pool, nowMs = Date.now()) {
  const normalized = (pool || []).map(item => {
    const dInfo = normalizeDistrict(item.ilce, item.ad);
    if (!dInfo.isMerkez) return null;
    const startMs = parseShiftMs(item.nobet_baslangic, item.start_iso);
    const endMs = parseShiftMs(item.nobet_bitis, item.end_iso);
    return {
      ...item,
      ilce: dInfo.ilce,
      ilceShort: dInfo.short || 'Merkez',
      telefon: formatPhoneDisplay(item.telefon_raw || item.telefon),
      telefon_raw: String(item.telefon_raw || item.telefon || '').replace(/\D/g, ''),
      startMs,
      endMs
    };
  }).filter(Boolean);

  // 1. Şu an tam olarak nöbette olanlar (startMs - 30dk <= nowMs <= endMs)
  const currentlyOpen = normalized.filter(e => {
    if (!e.startMs || !e.endMs) return true;
    return (nowMs >= e.startMs - 30 * 60 * 1000) && (nowMs <= e.endMs);
  });

  if (currentlyOpen.length > 0) {
    return { list: dedupeByPharmacyName(currentlyOpen), isStale: false };
  }

  // 2. Mesai/vardiya geçiş aralığındaysak (ör. 17:30-18:30 arası), önümüzdeki 6 saat içinde başlayacak vardiyayı göster
  const upcomingSoon = normalized.filter(e => e.startMs && e.endMs && e.startMs > nowMs && (e.startMs - nowMs <= 6 * 60 * 60 * 1000));
  if (upcomingSoon.length > 0) {
    const earliestStart = Math.min(...upcomingSoon.map(e => e.startMs));
    const nextBatch = upcomingSoon.filter(e => Math.abs(e.startMs - earliestStart) <= 90 * 60 * 1000);
    return { list: dedupeByPharmacyName(nextBatch), isStale: false };
  }

  // 3. Hiç aktif veya yakın vardiya yoksa veri eskimiştir! En son biten vardiyayı işaretle
  if (normalized.length > 0) {
    const maxEnd = Math.max(...normalized.map(e => e.endMs || 0));
    const latestBatch = maxEnd > 0
      ? normalized.filter(e => e.endMs && Math.abs(e.endMs - maxEnd) <= 4 * 60 * 60 * 1000)
      : normalized;
    return { list: dedupeByPharmacyName(latestBatch), isStale: true };
  }

  return { list: [], isStale: true };
}

function dedupeByPharmacyName(items) {
  const map = new Map();
  items.forEach(item => {
    const key = trUpper(item.ad).replace(/\s+/g, ' ').trim();
    const existing = map.get(key);
    // Aynı eczane hem kısa hem uzun vardiyada geçiyorsa bitişi daha geç olanı tut
    if (!existing || ((item.endMs || 0) > (existing.endMs || 0))) {
      map.set(key, item);
    }
  });
  return Array.from(map.values());
}

// ── MESAFE & SÜRE HESAPLAMA (Yürüme 🚶 + Araç 🚗) ──────────────────────────
function calcHaversineKm(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const p1 = parseFloat(lat1), l1 = parseFloat(lon1);
  const p2 = parseFloat(lat2), l2 = parseFloat(lon2);
  if ([p1, l1, p2, l2].some(Number.isNaN)) return null;
  const R = 6371;
  const dLat = (p2 - p1) * Math.PI / 180;
  const dLon = (l2 - l1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(p1 * Math.PI / 180) * Math.cos(p2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchJsonWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

async function enrichDistancesAndETAs(pharmacies) {
  // Önce Haversine tabanlı gerçekçi başlangıç tahminleri
  pharmacies.forEach(e => {
    const airKm = calcHaversineKm(POLEN_LAT, POLEN_LON, e.lat, e.lon);
    if (airKm === null) {
      e.walkKm = 999; e.walkMin = null;
      e.driveKm = 999; e.driveMin = null;
      e.uzaklik = 999;
    } else {
      e.walkKm = airKm * 1.28;
      e.walkMin = Math.max(1, Math.round((e.walkKm / 4.8) * 60));
      e.driveKm = airKm * 1.38;
      e.driveMin = Math.max(2, Math.round((e.driveKm / 26) * 60 + 1));
      e.uzaklik = e.walkKm <= 1.25 ? e.walkKm : e.driveKm;
    }
  });

  const valid = pharmacies.filter(e => e.lat && e.lon && !Number.isNaN(parseFloat(e.lat)) && !Number.isNaN(parseFloat(e.lon)));
  if (!valid.length) return;

  const coordsStr = `${POLEN_LON},${POLEN_LAT};` + valid.map(e => `${parseFloat(e.lon)},${parseFloat(e.lat)}`).join(';');
  const footUrl = `https://routing.openstreetmap.de/routed-foot/table/v1/driving/${coordsStr}?sources=0&annotations=distance,duration`;
  const carUrl = `https://router.project-osrm.org/table/v1/driving/${coordsStr}?sources=0&annotations=distance,duration`;

  const [footRes, carRes] = await Promise.allSettled([
    fetchJsonWithTimeout(footUrl, 4500),
    fetchJsonWithTimeout(carUrl, 4500)
  ]);

  if (footRes.status === 'fulfilled' && footRes.value?.code === 'Ok') {
    const dists = footRes.value.distances?.[0];
    const durs = footRes.value.durations?.[0];
    valid.forEach((e, i) => {
      const dm = dists?.[i + 1];
      const ds = durs?.[i + 1];
      if (dm && dm > 0) e.walkKm = dm / 1000;
      if (ds && ds > 0) e.walkMin = Math.max(1, Math.round(ds / 60));
    });
  }

  if (carRes.status === 'fulfilled' && carRes.value?.code === 'Ok') {
    const dists = carRes.value.distances?.[0];
    const durs = carRes.value.durations?.[0];
    valid.forEach((e, i) => {
      const dm = dists?.[i + 1];
      const ds = durs?.[i + 1];
      if (dm && dm > 0) e.driveKm = dm / 1000;
      if (ds && ds > 0) {
        // Şehir içi kavşak/park payı için gerçekçi +1 dk yuvarlama
        e.driveMin = Math.max(2, Math.round(ds / 60 + 1));
      }
    });
  }

  valid.forEach(e => {
    e.isWalkable = e.walkKm <= 1.25;
    e.uzaklik = e.isWalkable ? e.walkKm : Math.min(e.driveKm, e.walkKm * 1.15);
    e.travelMin = e.isWalkable ? e.walkMin : e.driveMin;
  });
}

function sortPharmaciesSmart(list, nowMs = Date.now()) {
  return [...list].sort((a, b) => {
    const aRemMin = a.endMs ? (a.endMs - nowMs) / 60000 : 999;
    const bRemMin = b.endMs ? (b.endMs - nowMs) / 60000 : 999;
    const aClosingRisk = aRemMin > 0 && aRemMin <= Math.max(20, (a.travelMin || 10) + 8);
    const bClosingRisk = bRemMin > 0 && bRemMin <= Math.max(20, (b.travelMin || 10) + 8);
    if (aClosingRisk !== bClosingRisk) return aClosingRisk ? 1 : -1;
    return (a.uzaklik || 999) - (b.uzaklik || 999);
  });
}

// ── VERİ ÇEKME (3 Katmanlı Kesintisiz Mimari) ───────────────────────────────
function isLocalNetworkHost() {
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.') || h.startsWith('10.');
}

async function fetchPayloadFromSource(force = false) {
  const ts = `?_ts=${Date.now()}`;

  // Katman 1: Yerel Python sunucusu çalışıyorsa /api/pharmacies
  if (isLocalNetworkHost() && window.location.protocol !== 'file:') {
    try {
      const apiRes = await fetch(`/api/pharmacies${force ? ts : ''}`, { cache: 'no-store' });
      if (apiRes.ok) {
        const apiJson = await apiRes.json();
        const pool = apiJson.pharmacies || (apiJson.contents ? parseLegacyHtml(apiJson.contents) : []);
        if (pool.length > 0) {
          return { pool, lastUpdated: apiJson.last_updated, mode: 'api' };
        }
      }
    } catch (_) {
      // Statik sunucuysa data.json'a geç
    }
  }

  // Katman 2: GitHub Actions tarafından güncellenen 5 günlük takvimli data.json
  let staleCandidate = null;
  try {
    const res = await fetch(`data.json${ts}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const pool = Array.isArray(data.pharmacies)
        ? data.pharmacies
        : (data.contents ? parseLegacyHtml(data.contents) : []);

      if (pool.length > 0) {
        const check = selectCurrentShiftPharmacies(pool, Date.now());
        if (!check.isStale) {
          try {
            localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify({ pool, lastUpdated: data.last_updated }));
          } catch (_) {}
          return { pool, lastUpdated: data.last_updated, mode: 'json' };
        }
        // data.json var ama içindeki tüm vardiyaların süresi dolmuş -> Canlı yedeği dene!
        staleCandidate = { pool, lastUpdated: data.last_updated };
      }
    }
  } catch (err) {
    console.warn('data.json okunamadi:', err);
  }

  // Katman 3: Otomatik Canlı Yedek (Jina üzerinden doğrudan Eczacı Odası)
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 9000);
    const liveRes = await fetch(`${JINA_LIVE_FAILOVER_URL}`, {
      cache: 'no-store',
      signal: controller.signal
    });
    clearTimeout(tid);
    if (liveRes.ok) {
      const text = await liveRes.text();
      const livePool = text.includes('<div') ? parseLegacyHtml(text) : parseJinaMarkdown(text);
      if (livePool.length > 0) {
        const nowIso = new Date().toISOString();
        try {
          localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify({ pool: livePool, lastUpdated: nowIso }));
        } catch (_) {}
        return { pool: livePool, lastUpdated: nowIso, mode: 'live-failover' };
      }
    }
  } catch (liveErr) {
    console.warn('Canli yedek kaynak alinamadi:', liveErr);
  }

  // Katman 4: Çevrimdışı Önbellek / Eski Veri (Açık Uyarı İle)
  if (staleCandidate) {
    return { ...staleCandidate, mode: 'stale-cache' };
  }
  try {
    const cached = JSON.parse(localStorage.getItem(LIVE_CACHE_KEY) || 'null');
    if (cached && Array.isArray(cached.pool) && cached.pool.length > 0) {
      return { pool: cached.pool, lastUpdated: cached.lastUpdated, mode: 'stale-cache' };
    }
  } catch (_) {}

  throw new Error('Hiçbir veri kaynağına ulaşılamadı.');
}

async function veriGetir(force = false) {
  const btn = document.getElementById('ybtn');
  const st = document.getElementById('status');
  const si = document.getElementById('si');
  const stText = document.getElementById('st');
  const grid = document.getElementById('grid');

  if (btn) {
    btn.textContent = '⏳';
    btn.classList.add('loading');
  }
  if (!activePharmacies.length) {
    if (st) st.className = 'show';
    if (si) si.textContent = '⏳';
    if (stText) stText.textContent = 'Nöbetçi eczaneler güncelleniyor… Lütfen bekleyiniz.';
    if (grid) grid.innerHTML = '';
  }

  try {
    const result = await fetchPayloadFromSource(force);
    rawSchedulePool = result.pool;
    lastUpdatedIso = result.lastUpdated;
    dataSourceMode = result.mode;

    await refreshActiveShiftView(true);

    if (st) st.className = '';
  } catch (e) {
    console.error(e);
    if (!activePharmacies.length) {
      if (st) st.className = 'show';
      if (si) si.textContent = '❌';
      if (stText) stText.textContent = 'Ağ Hatası: Veriler alınamadı. Lütfen internet bağlantınızı kontrol edin.';
    }
  } finally {
    if (btn) {
      btn.textContent = '⟳';
      btn.classList.remove('loading');
    }
  }
}

async function refreshActiveShiftView(recalculateRoutes = false) {
  if (!rawSchedulePool.length) return;
  const nowMs = Date.now();
  const { list, isStale } = selectCurrentShiftPharmacies(rawSchedulePool, nowMs);

  if (recalculateRoutes || !activePharmacies.length || list.length !== activePharmacies.length) {
    await enrichDistancesAndETAs(list);
  } else {
    // Mevcut hesaplanmış mesafeleri koru
    const prevMap = new Map(activePharmacies.map(p => [trUpper(p.ad), p]));
    list.forEach(item => {
      const prev = prevMap.get(trUpper(item.ad));
      if (prev) {
        item.walkKm = prev.walkKm;
        item.walkMin = prev.walkMin;
        item.driveKm = prev.driveKm;
        item.driveMin = prev.driveMin;
        item.isWalkable = prev.isWalkable;
        item.uzaklik = prev.uzaklik;
        item.travelMin = prev.travelMin;
      }
    });
  }

  activePharmacies = sortPharmaciesSmart(list, nowMs);
  updateStaleAndLiveIndicators(isStale || dataSourceMode === 'stale-cache');
  updateDutyStatusAndFooter();
  updateFilterCounts();
  renderFilteredView();
}

function updateStaleAndLiveIndicators(isStale) {
  const staleBanner = document.getElementById('staleBanner');
  const liveText = document.getElementById('liveText');
  const liveBadge = document.getElementById('liveBadge');

  if (isStale) {
    if (staleBanner) {
      staleBanner.innerHTML = '⚠️ <strong>Veri Güncelleniyor:</strong> Yeni nöbet listesi henüz yayınlanmadı veya bağlantı bekleniyor. Gösterilen eczaneleri gitmeden önce telefonla arayınız.';
      staleBanner.style.display = 'flex';
    }
    if (liveText) liveText.textContent = 'YENİLENİYOR';
    if (liveBadge) liveBadge.classList.add('is-warning');
  } else {
    if (staleBanner) staleBanner.style.display = 'none';
    if (liveText) liveText.textContent = dataSourceMode === 'live-failover' ? 'CANLI YEDEK' : 'CANLI';
    if (liveBadge) liveBadge.classList.remove('is-warning');
  }
}

function updateDutyStatusAndFooter() {
  const isPolenOnDuty = activePharmacies.some(e => trUpper(e.ad).includes('POLEN'));
  const spill = document.getElementById('spill');
  if (isPolenOnDuty) {
    if (settings.dutyAlert) document.body.classList.add('we-are-onduty');
    if (spill) {
      spill.innerHTML = '🚨 BUGÜN NÖBETÇİYİZ 🚨';
      spill.style.background = 'rgba(227, 6, 19, 0.85)';
      spill.style.color = '#fff';
    }
  } else {
    document.body.classList.remove('we-are-onduty');
    if (spill) {
      spill.style.background = '';
      spill.style.color = '';
    }
  }

  const luEl = document.getElementById('last-updated');
  if (luEl && lastUpdatedIso) {
    const lDate = new Date(lastUpdatedIso);
    if (!Number.isNaN(lDate.getTime())) {
      const luDateStr = lDate.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
      const luTimeStr = lDate.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      luEl.innerHTML = `Veri Kontrol: <em>${luDateStr} ${luTimeStr}</em>`;
      luEl.style.display = 'inline-flex';
    }
  }
}

// ── İLÇE FİLTRESİ (Dokunmatik, Mobil ve TV Kumanda Uyumlu) ──────────────────
function updateFilterCounts() {
  const total = activePharmacies.length;
  const odun = activePharmacies.filter(e => e.ilce.includes('ODUNPAZARI')).length;
  const tepe = activePharmacies.filter(e => e.ilce.includes('TEPEBAŞI')).length;

  document.querySelectorAll('#filterBar .fbtn[data-district]').forEach(btn => {
    const d = btn.getAttribute('data-district');
    if (d === 'ALL') btn.textContent = `Tümü (${total})`;
    else if (d === 'ODUNPAZARI') btn.textContent = `Odunpazarı (${odun})`;
    else if (d === 'TEPEBAŞI') btn.textContent = `Tepebaşı (${tepe})`;
    btn.classList.toggle('active', d === currentDistrict);
  });
}

function setDistrictFilter(district) {
  currentDistrict = district;
  selectedPharmIndex = -1;
  updateFilterCounts();
  renderFilteredView();

  // Kiosk / TV ekranında filtre seçili unutulursa 90 sn sonra otomatik Tümü'ne dön
  if (districtResetTimer) clearTimeout(districtResetTimer);
  if (district !== 'ALL' && !isMobileMode) {
    districtResetTimer = setTimeout(() => {
      currentDistrict = 'ALL';
      updateFilterCounts();
      renderFilteredView();
    }, 90000);
  }
}

function getFilteredPharmacies() {
  if (currentDistrict === 'ALL') return activePharmacies;
  return activePharmacies.filter(e => e.ilce.includes(currentDistrict));
}

function toggleMobileMap() {
  const sideCol = document.getElementById('sideCol');
  const btn = document.getElementById('mobileMapBtn');
  if (!sideCol) return;
  const willShow = !sideCol.classList.contains('mobile-visible');
  sideCol.classList.toggle('mobile-visible', willShow);
  if (btn) btn.classList.toggle('active', willShow);
  if (willShow && mapInstance) {
    setTimeout(() => {
      mapInstance.invalidateSize();
      drawLiveMap(getFilteredPharmacies());
    }, 250);
  }
}

// ── KART GÖRÜNÜMÜ (Yürüme/Araç ETA + Yarı Nöbet / Kapanış Uyarısı) ──────────
function buildDistanceChip(e) {
  if (!e.uzaklik || e.uzaklik >= 999) return '';
  if (e.isWalkable && e.walkMin) {
    const distLabel = e.walkKm < 1 ? `${Math.round(e.walkKm * 1000)} m` : `${e.walkKm.toFixed(1)} km`;
    return `<span class="chip chip-walk" title="Yürüme mesafesi (Araçla ~${e.driveMin || 3} dk)">🚶 ${e.walkMin} dk · ${distLabel}</span>`;
  }
  const driveLabel = `${(e.driveKm || e.uzaklik).toFixed(1)} km`;
  const minPart = e.driveMin ? `${e.driveMin} dk · ` : '';
  return `<span class="chip chip-drive" title="Araç rotası mesafesi">🚗 ${minPart}${driveLabel}</span>`;
}

function buildShiftAndWarningChips(e, maxEndMs, nowMs) {
  let chipsHtml = '';
  let timeRangeStr = '';

  if (e.nobet_baslangic && e.nobet_bitis) {
    const bParts = e.nobet_baslangic.split(' ');
    const eParts = e.nobet_bitis.split(' ');
    const bTime = bParts[1] || bParts[0];
    const eTime = eParts[1] || eParts[0];
    timeRangeStr = `${bTime} – ${eTime}`;
  }

  // Yarı nöbet tespiti (diğer eczanelerden en az 2 saat erken bitiyorsa, örn. 00:00'a kadar)
  const isPartialShift = e.endMs && maxEndMs && (maxEndMs - e.endMs >= 2 * 60 * 60 * 1000);
  const remMin = e.endMs ? Math.round((e.endMs - nowMs) / 60000) : null;

  if (remMin !== null && remMin > 0 && remMin <= 60) {
    const urgent = remMin <= Math.max(20, (e.travelMin || 8) + 5);
    chipsHtml += `<span class="chip ${urgent ? 'chip-danger' : 'chip-warn'}">${urgent ? '⛔' : '⏳'} Kapanmasına ${remMin} dk kaldı</span>`;
  } else if (isPartialShift && e.nobet_bitis) {
    const endClock = e.nobet_bitis.split(' ')[1] || e.nobet_bitis;
    chipsHtml += `<span class="chip chip-warn">⚠️ Saat ${endClock}'a kadar açık</span>`;
  } else if (timeRangeStr) {
    chipsHtml += `<span class="chip chip-s"><svg class="icn-sm anim-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${timeRangeStr}</span>`;
  }

  return chipsHtml;
}

function getDirectionsUrl(e) {
  if (e.lat && e.lon) {
    const mode = e.isWalkable ? 'walking' : 'driving';
    return `https://www.google.com/maps/dir/?api=1&destination=${e.lat},${e.lon}&travelmode=${mode}`;
  }
  if (e.harita_link && e.harita_link.startsWith('http')) return e.harita_link;
  if (e.adres) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.ad + ' ' + e.adres + ' Eskişehir')}`;
  return '';
}

function renderFilteredView() {
  const data = getFilteredPharmacies();
  document.body.classList.toggle('layout-dense', !isMobileMode && data.length > 14);

  const grid = document.getElementById('grid');
  const spill = document.getElementById('spill');
  const isPolenOnDuty = activePharmacies.some(e => trUpper(e.ad).includes('POLEN'));

  if (grid) grid.innerHTML = '';
  if (spill && !isPolenOnDuty) {
    spill.innerHTML = `<em>${data.length}</em> nöbetçi eczane`;
  }

  if (!data.length) {
    if (grid) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:60px;color:#64748b;font-size:16px">⚗️ Seçilen filtrede nöbetçi eczane bulunamadı.</div>';
    }
    drawLiveMap([]);
    return;
  }

  const nowMs = Date.now();
  const maxEndMs = Math.max(...data.map(e => e.endMs || 0));

  data.forEach((e, i) => {
    const murl = getDirectionsUrl(e);
    const addr = (e.adres || '').substring(0, 165);
    const telHref = e.telefon_raw ? `tel:${e.telefon_raw}` : '';
    const distChip = buildDistanceChip(e);
    const shiftChips = buildShiftAndWarningChips(e, maxEndMs, nowMs);
    const districtBadge = e.ilceShort ? `<span class="district-tag">${e.ilceShort}</span>` : '';

    const c = document.createElement('div');
    c.className = 'card';
    c.setAttribute('tabindex', '0');
    c.dataset.idx = String(i);

    c.innerHTML = `
      <div class="ci">
        <div class="cname-row">
          <div class="cname">
            <svg class="anim-logo" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 1.35em; height: 1.35em; margin-right: 10px; flex-shrink: 0; border-radius: 20%;">
              <rect width="100" height="100" rx="28" fill="#E30613"/>
              <path d="M65 25 L35 25 L35 75 L65 75 M35 50 L55 50" stroke="white" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>${e.ad || '—'}</span>
          </div>
          ${districtBadge}
        </div>
        <div class="caddr"><span class="caddr-ic" style="margin-right:4px;">
          <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-0.15em;"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg>
        </span><span>${addr || 'Adres bilgisi yok'}</span></div>
        <div class="chips">
          ${distChip}
          ${e.telefon ? `<span class="chip chip-t"><svg class="icn-sm anim-ring" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> ${e.telefon}</span>` : ''}
          ${shiftChips}
        </div>
        <div class="mobile-actions">
          ${telHref ? `<a class="m-btn m-btn-call" href="${telHref}" onclick="event.stopPropagation()">📞 Hemen Ara</a>` : ''}
          ${murl ? `<a class="m-btn m-btn-nav" href="${murl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🗺️ Yol Tarifi Al</a>` : ''}
        </div>
      </div>
      <div class="cqr">
        <div class="qrbox" id="qr${i}"></div>
        <div class="qrlbl"><strong>QR okut</strong><br>yol tarifi</div>
      </div>`;

    c.addEventListener('click', () => focusPharmacyOnMap(e, i));
    c.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        focusPharmacyOnMap(e, i);
      }
    });

    if (grid) grid.appendChild(c);
    if (!isMobileMode && murl) {
      setTimeout(() => makeQR(document.getElementById('qr' + i), murl), 0);
    }
  });

  if (typeof injectAds === 'function') injectAds();
  drawLiveMap(data);
}

// ── HARİTA VE CANLI ROTA ÇİZİMİ ─────────────────────────────────────────────
let mapInstance = null;
let pharmMarkers = [];
let activeRouteLayer = null;

function drawLiveMap(data) {
  const mapEl = document.getElementById('liveMap');
  if (!mapEl || typeof L === 'undefined') return;
  if (isMobileMode && !document.getElementById('sideCol')?.classList.contains('mobile-visible')) return;

  if (!mapInstance) {
    mapInstance = L.map('liveMap', { zoomControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(mapInstance);
  }

  setTimeout(() => mapInstance.invalidateSize(), 300);

  mapInstance.eachLayer(layer => {
    if (layer instanceof L.Marker || layer instanceof L.Polyline) {
      mapInstance.removeLayer(layer);
    }
  });
  pharmMarkers = [];
  activeRouteLayer = null;

  const bounds = [];
  const ptIcon = L.divIcon({
    className: 'custom-pin',
    html: '<div style="background:#ef4444; border:3px solid #fff; border-radius:50%; width:20px; height:20px; box-shadow:0 0 12px rgba(239, 68, 68, 0.9); margin:0 auto;"></div><div style="text-align:center; font-weight:800; font-size:11px; margin-top:2px; color:#dc2626; text-shadow:0 0 4px #fff, 0 0 4px #fff;">Polen Eczanesi</div>',
    iconSize: [120, 48],
    iconAnchor: [60, 10]
  });
  L.marker([POLEN_LAT, POLEN_LON], { icon: ptIcon }).addTo(mapInstance);
  bounds.push([POLEN_LAT, POLEN_LON]);

  data.forEach((e, idx) => {
    if (e.lat && e.lon) {
      const isNearest = idx === 0;
      const pinColor = isNearest ? '#10b981' : '#2563eb';
      const mIcon = L.divIcon({
        className: 'pharm-pin',
        html: `<div style="background:${pinColor}; border:2px solid #fff; border-radius:50%; width:${isNearest ? 18 : 14}px; height:${isNearest ? 18 : 14}px; box-shadow:0 0 8px rgba(0,0,0,0.5);"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      });
      const etaSummary = e.isWalkable
        ? `🚶 ${e.walkMin || '?'} dk (${Math.round(e.walkKm * 1000)} m)`
        : `🚗 ${e.driveMin || '?'} dk (${(e.driveKm || e.uzaklik).toFixed(1)} km)`;
      const marker = L.marker([parseFloat(e.lat), parseFloat(e.lon)], { icon: mIcon })
        .bindPopup(`<b>${e.ad}</b><br>${etaSummary}<br><small>${e.ilceShort || ''}</small>`)
        .addTo(mapInstance);
      pharmMarkers[idx] = marker;
      bounds.push([parseFloat(e.lat), parseFloat(e.lon)]);
    }
  });

  if (bounds.length > 1) {
    mapInstance.fitBounds(bounds, { padding: [28, 28] });
  } else if (bounds.length === 1) {
    mapInstance.setView(bounds[0], 14);
  }

  // Varsayılan olarak en yakın nöbetçi eczanenin rotasını haritada hazır çiz
  if (data.length > 0 && data[0].lat && data[0].lon) {
    drawRouteLine(data[0], false);
  }
}

async function drawRouteLine(pharm, zoomToRoute = true) {
  if (!mapInstance || !pharm?.lat || !pharm?.lon) return;
  if (activeRouteLayer) {
    mapInstance.removeLayer(activeRouteLayer);
    activeRouteLayer = null;
  }

  const destLat = parseFloat(pharm.lat);
  const destLon = parseFloat(pharm.lon);
  const hintEl = document.getElementById('mapRouteHint');
  const routeColor = pharm.isWalkable ? '#10b981' : '#2563eb';

  try {
    const base = pharm.isWalkable
      ? 'https://routing.openstreetmap.de/routed-foot/route/v1/driving'
      : 'https://router.project-osrm.org/route/v1/driving';
    const url = `${base}/${POLEN_LON},${POLEN_LAT};${destLon},${destLat}?overview=full&geometries=geojson`;
    const json = await fetchJsonWithTimeout(url, 4000);
    const coords = json?.routes?.[0]?.geometry?.coordinates;
    if (coords && coords.length > 1) {
      const latLngs = coords.map(([lon, lat]) => [lat, lon]);
      activeRouteLayer = L.polyline(latLngs, {
        color: routeColor,
        weight: 5,
        opacity: 0.85,
        dashArray: pharm.isWalkable ? '8, 8' : null
      }).addTo(mapInstance);
      if (zoomToRoute) {
        mapInstance.fitBounds(activeRouteLayer.getBounds(), { padding: [36, 36] });
      }
      if (hintEl) {
        hintEl.textContent = `${pharm.ad} rotası (${pharm.isWalkable ? `🚶 ${pharm.walkMin} dk` : `🚗 ${pharm.driveMin} dk`})`;
      }
      return;
    }
  } catch (_) {}

  // Yedek düz çizgi
  activeRouteLayer = L.polyline([[POLEN_LAT, POLEN_LON], [destLat, destLon]], {
    color: routeColor,
    weight: 4,
    opacity: 0.7,
    dashArray: '6, 8'
  }).addTo(mapInstance);
  if (zoomToRoute) {
    mapInstance.fitBounds(activeRouteLayer.getBounds(), { padding: [36, 36] });
  }
}

function focusPharmacyOnMap(pharm, idx) {
  selectedPharmIndex = idx;
  document.querySelectorAll('#grid .card').forEach(el => {
    el.classList.toggle('selected-card', el.dataset.idx === String(idx));
  });

  if (isMobileMode) {
    const sideCol = document.getElementById('sideCol');
    if (sideCol && !sideCol.classList.contains('mobile-visible')) {
      toggleMobileMap();
    }
  }

  if (pharmMarkers[idx]) {
    pharmMarkers[idx].openPopup();
  }
  drawRouteLine(pharm, true);
}

// ── CANLI HAVA DURUMU ───────────────────────────────────────────────────────
async function fetchWeather() {
  if (!settings.weatherOn) {
    const wEl = document.getElementById('weather');
    const waEl = document.getElementById('weatherAdvice');
    const weLayer = document.getElementById('weatherEffectLayer');
    if (wEl) wEl.style.display = 'none';
    if (waEl) waEl.style.display = 'none';
    if (weLayer) weLayer.innerHTML = '';
    document.body.classList.remove('weather-snow', 'weather-rain', 'weather-clear');
    return;
  }

  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${POLEN_LAT}&longitude=${POLEN_LON}&current_weather=true&timezone=Europe/Istanbul`);
    const wData = await res.json();
    if (wData && wData.current_weather) {
      const temp = Math.round(wData.current_weather.temperature);
      const code = wData.current_weather.weathercode;

      let bgClass = '';
      let icon = '🌤️';
      if (code === 0) { icon = '☀️'; bgClass = 'weather-clear'; }
      else if ([1, 2, 3].includes(code)) { icon = '⛅'; }
      else if (code >= 40 && code <= 49) { icon = '🌫️'; }
      else if ((code >= 50 && code <= 69) || (code >= 80 && code <= 82)) { icon = '🌧️'; bgClass = 'weather-rain'; }
      else if ((code >= 70 && code <= 79) || (code >= 85 && code <= 86)) { icon = '🌨️'; bgClass = 'weather-snow'; }
      else if (code >= 90 && code <= 99) { icon = '⛈️'; bgClass = 'weather-rain'; }

      document.body.classList.remove('weather-snow', 'weather-rain', 'weather-clear');
      if (bgClass) document.body.classList.add(bgClass);

      const wTemp = document.getElementById('w_temp');
      const wIcon = document.getElementById('w_icon');
      const wHeader = document.getElementById('weather');
      if (wTemp) wTemp.textContent = temp + '°C';
      if (wIcon) wIcon.textContent = icon;
      if (wHeader) wHeader.style.display = 'flex';

      updateWeatherAdvice(code, temp);
      updateWeatherEffects(bgClass);
    }
  } catch (e) {
    console.warn('Hava durumu alinamadi:', e);
  }
}

function updateWeatherAdvice(code, temp) {
  const pickRandom = arr => arr[Math.floor(Math.random() * arr.length)];
  let adviceText = 'Sağlıklı günler dileriz!';
  let adviceIcon = '🌟';

  if (code === 0) {
    adviceIcon = '🧴';
    adviceText = pickRandom([
      'Güneşli günlerde UV ışınlarına karşı cildinizi korumak için cilt tipinize uygun güneş kremlerini eczanemizden temin edebilirsiniz.',
      'Güneşin tadını çıkarırken cilt lekelerine karşı dermokozmetik güneş koruyucularımızı incelemeyi unutmayın.'
    ]);
  } else if ([1, 2, 3].includes(code)) {
    adviceIcon = '💊';
    adviceText = 'Mevsim geçişlerinde bağışıklığınızı destekleyecek vitamin ve mineral destekleri için eczacınıza danışabilirsiniz.';
  } else if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) {
    adviceIcon = '🤧';
    adviceText = 'Yağışlı havalarda soğuk algınlığı belirtilerine karşı bitkisel destekler ve pastiller için eczanemize bekleriz.';
  } else if ([71, 73, 75, 77, 85, 86].includes(code)) {
    adviceIcon = '❄️';
    adviceText = 'Soğuk ve karlı havalarda kuruyan cilt ve dudaklar için yoğun nemlendirici bakım ürünlerimiz eczanemizde.';
  }

  if (temp < 6) adviceText = '⚠️ ' + adviceText + ' Soğuk havalarda bağışıklık direncinizi yüksek tutun.';

  const wa = document.getElementById('weatherAdvice');
  const waIcon = document.getElementById('waIcon');
  const waText = document.getElementById('waText');
  if (wa && waIcon && waText) {
    waIcon.textContent = adviceIcon;
    waText.textContent = adviceText;
    wa.style.display = isMobileMode ? 'none' : 'flex';
  }
}

function updateWeatherEffects(bgClass) {
  const layer = document.getElementById('weatherEffectLayer');
  if (!layer) return;
  layer.innerHTML = '';
  if (!settings.animationsOn || !bgClass || isMobileMode) return;

  if (bgClass === 'weather-rain') {
    for (let i = 0; i < 28; i++) {
      const drop = document.createElement('div');
      drop.className = 'raindrop';
      drop.style.left = Math.random() * 100 + 'vw';
      drop.style.animationDuration = (Math.random() * 0.5 + 0.5) + 's';
      drop.style.animationDelay = Math.random() * 2 + 's';
      layer.appendChild(drop);
    }
  } else if (bgClass === 'weather-snow') {
    for (let i = 0; i < 28; i++) {
      const flake = document.createElement('div');
      flake.className = 'snowflake';
      flake.style.left = Math.random() * 100 + 'vw';
      const size = (Math.random() * 5 + 2) + 'px';
      flake.style.width = size;
      flake.style.height = size;
      flake.style.animationDuration = (Math.random() * 3 + 2) + 's';
      flake.style.animationDelay = Math.random() * 5 + 's';
      flake.style.opacity = Math.random();
      layer.appendChild(flake);
    }
  }
}

// ── AYARLAR SİSTEMİ ─────────────────────────────────────────────────────────
const DEFAULTS = {
  theme: 'modern',
  sidebarOn: true,
  fsAd: false,
  weatherOn: true,
  dutyAlert: true,
  autoScroll: false,
  scrollSpeed: 'medium',
  animationsOn: true
};

function loadSettings() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('polenSettings2') || '{}')); }
  catch (_) { return { ...DEFAULTS }; }
}
function saveSettings(s) { localStorage.setItem('polenSettings2', JSON.stringify(s)); }

let settings = loadSettings();
let scrollInterval = null;
let fsAdInterval = null;
let currentAdIndex = 0;

function settingsToUI(s) {
  const rModern = document.getElementById('themeModern');
  const rClassic = document.getElementById('themeClassic');
  const sSidebar = document.getElementById('sSidebar');
  const sFsAd = document.getElementById('sFsAd');
  const sWeather = document.getElementById('sWeather');
  const sDutyAlert = document.getElementById('sDutyAlert');
  const sScroll = document.getElementById('sScroll');
  const sScrollSpeed = document.getElementById('sScrollSpeed');
  const sAnimations = document.getElementById('sAnimations');

  if (s.theme === 'classic') { if (rClassic) rClassic.checked = true; }
  else { if (rModern) rModern.checked = true; }
  if (sSidebar) sSidebar.checked = s.sidebarOn !== false;
  if (sFsAd) sFsAd.checked = s.fsAd;
  if (sWeather) sWeather.checked = s.weatherOn;
  if (sDutyAlert) sDutyAlert.checked = s.dutyAlert;
  if (sScroll) sScroll.checked = s.autoScroll;
  if (sScrollSpeed) sScrollSpeed.value = s.scrollSpeed;
  if (sAnimations) sAnimations.checked = s.animationsOn !== false;
}

function uiToSettings() {
  return {
    theme: document.querySelector('input[name="theme"]:checked')?.value || 'modern',
    sidebarOn: document.getElementById('sSidebar').checked,
    fsAd: document.getElementById('sFsAd').checked,
    weatherOn: document.getElementById('sWeather').checked,
    dutyAlert: document.getElementById('sDutyAlert').checked,
    autoScroll: document.getElementById('sScroll').checked,
    scrollSpeed: document.getElementById('sScrollSpeed').value,
    animationsOn: document.getElementById('sAnimations').checked,
    campList: settings.campList || []
  };
}

function applySettings(s) {
  document.body.setAttribute('data-theme', s.theme || 'modern');
  document.body.classList.toggle('no-animations', s.animationsOn === false);

  if (scrollInterval) { clearInterval(scrollInterval); scrollInterval = null; }
  if (s.autoScroll && !isMobileMode) { startAutoScroll(s.scrollSpeed); }

  if (fsAdInterval) { clearInterval(fsAdInterval); fsAdInterval = null; }
  const fsAdOverlay = document.getElementById('fsAdOverlay');
  if (fsAdOverlay) fsAdOverlay.classList.remove('active');
  if (s.fsAd && !isMobileMode) { fsAdInterval = setInterval(playNextAd, 120000); }

  const wHeader = document.getElementById('weather');
  if (wHeader) wHeader.style.display = s.weatherOn ? 'flex' : 'none';
  if (!s.weatherOn) {
    document.body.classList.remove('weather-snow', 'weather-rain', 'weather-clear');
  } else {
    fetchWeather();
  }

  if (!s.dutyAlert) document.body.classList.remove('we-are-onduty');

  const sidebar = document.querySelector('.side-col');
  if (sidebar && !isMobileMode) {
    sidebar.style.display = (s.sidebarOn !== false) ? 'flex' : 'none';
    if (s.sidebarOn !== false) {
      setTimeout(() => { if (mapInstance) mapInstance.invalidateSize(); }, 300);
    }
  }
}

function playNextAd() {
  const camps = loadCampaigns();
  if (!camps || camps.length === 0) return;

  const overlay = document.getElementById('fsAdOverlay');
  if (!overlay) return;
  const cur = camps[currentAdIndex % camps.length];

  const adTitle = document.getElementById('fsAdTitle');
  const adDesc = document.getElementById('fsAdDesc');
  const adImg = document.getElementById('fsAdImg');

  if (adTitle) adTitle.textContent = cur.title || '';
  if (adDesc) adDesc.textContent = cur.desc || '';
  if (adImg) adImg.style.backgroundImage = cur.img ? `url(${cur.img})` : 'none';

  if (cur.color === 'gold') overlay.style.background = 'linear-gradient(135deg, #443 0%, #111 100%)';
  else if (cur.color === 'red') overlay.style.background = 'linear-gradient(135deg, #500 0%, #111 100%)';
  else if (cur.color === 'blue') overlay.style.background = 'linear-gradient(135deg, #004 0%, #111 100%)';
  else if (cur.color === 'green') overlay.style.background = 'linear-gradient(135deg, #031 0%, #111 100%)';
  else overlay.style.background = '#0f111a';

  overlay.classList.add('active');
  setTimeout(() => {
    overlay.classList.remove('active');
    currentAdIndex++;
  }, 15000);
}

function startAutoScroll(speed) {
  const area = document.getElementById('mainCol');
  if (!area) return;
  const speeds = { slow: 1, medium: 2, fast: 4 };
  const px = speeds[speed] || 2;
  let dir = 1;
  scrollInterval = setInterval(() => {
    if (area.scrollHeight <= area.clientHeight + 8) return;
    area.scrollTop += dir * px;
    if (area.scrollTop + area.clientHeight >= area.scrollHeight - 5) {
      dir = 0;
      setTimeout(() => { area.scrollTop = 0; dir = 1; }, 3500);
    }
  }, 45);
}

function openSettings() {
  settingsToUI(settings);
  const overlay = document.getElementById('settingsOverlay');
  if (overlay) overlay.classList.add('open');
}
function closeSettings() {
  settings = uiToSettings();
  saveSettings(settings);
  applySettings(settings);
  const overlay = document.getElementById('settingsOverlay');
  if (overlay) overlay.classList.remove('open');
}
function overlayClick(e) {
  if (e.target === document.getElementById('settingsOverlay')) closeSettings();
}

// ── KAMPANYA REKLAM SİSTEMİ ─────────────────────────────────────────────────
function loadCampaigns() {
  try { return JSON.parse(localStorage.getItem('polenCampaigns') || '[]'); }
  catch (_) { return []; }
}
function saveCampaigns(c) { localStorage.setItem('polenCampaigns', JSON.stringify(c)); }

const CAMP_COLORS = {
  gold: { border: 'rgba(255,180,50,.4)', title: '#f1c40f', glow: 'rgba(241,196,15,.3)', bg1: 'rgba(60,45,10,.9)', bg2: 'rgba(40,30,5,.95)' },
  red: { border: 'rgba(231,76,60,.4)', title: '#e74c3c', glow: 'rgba(231,76,60,.3)', bg1: 'rgba(60,15,10,.9)', bg2: 'rgba(40,10,5,.95)' },
  green: { border: 'rgba(46,204,113,.4)', title: '#2ecc71', glow: 'rgba(46,204,113,.3)', bg1: 'rgba(10,50,25,.9)', bg2: 'rgba(5,35,15,.95)' },
  blue: { border: 'rgba(52,152,219,.4)', title: '#3498db', glow: 'rgba(52,152,219,.3)', bg1: 'rgba(10,25,55,.9)', bg2: 'rgba(5,15,40,.95)' },
  purple: { border: 'rgba(155,89,182,.4)', title: '#9b59b6', glow: 'rgba(155,89,182,.3)', bg1: 'rgba(35,15,50,.9)', bg2: 'rgba(25,10,40,.95)' }
};

function renderCampList() {
  const list = document.getElementById('campList');
  if (!list) return;
  const camps = loadCampaigns();
  list.innerHTML = camps.length === 0 ? '<div style="color:#555;font-size:12px;padding:8px;text-align:center">Henüz kampanya eklenmedi</div>' :
    camps.map((c, i) => `<div class="camp-item"><span class="camp-name">${c.title}</span><button class="camp-del" onclick="deleteCamp(${i})">Sil</button></div>`).join('');
}

function deleteCamp(idx) {
  const camps = loadCampaigns();
  camps.splice(idx, 1);
  saveCampaigns(camps);
  renderCampList();
  injectAds();
}

function injectAds() {
  if (isMobileMode) return;
  const grid = document.getElementById('grid');
  if (!grid) return;
  grid.querySelectorAll('.card-ad').forEach(el => el.remove());
  const camps = loadCampaigns();
  camps.forEach(camp => {
    const col = CAMP_COLORS[camp.color] || CAMP_COLORS.gold;
    const card = document.createElement('div');
    card.className = 'card card-ad';
    card.style.border = `1px solid ${col.border}`;
    card.style.background = `linear-gradient(135deg,${col.bg1},${col.bg2})`;
    card.innerHTML = `
      <div class="ad-badge">KAMPANYA</div>
      <div class="ad-content">
        ${camp.img ? `<img class="ad-img" src="${camp.img}" alt="${camp.title}" onerror="this.style.display='none'">` : ''}
        <div class="ad-title" style="color:${col.title};text-shadow:0 0 20px ${col.glow}">${camp.title}</div>
        ${camp.desc ? `<div class="ad-desc">${camp.desc}</div>` : ''}
      </div>`;
    grid.appendChild(card);
  });
}

// ── BAŞLATMA VE PERİYODİK KONTROLLER ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const campAdd = document.getElementById('campAdd');
  if (campAdd) {
    campAdd.addEventListener('click', () => {
      const title = document.getElementById('campTitle').value.trim();
      if (!title) return;
      const camps = loadCampaigns();
      camps.push({
        title,
        desc: document.getElementById('campDesc').value.trim(),
        img: document.getElementById('campImg').value.trim(),
        color: document.getElementById('campColor').value
      });
      saveCampaigns(camps);
      renderCampList();
      injectAds();
      document.getElementById('campTitle').value = '';
      document.getElementById('campDesc').value = '';
      document.getElementById('campImg').value = '';
    });
  }

  // Sağ panel "Listeyi Telefonuna Al" QR kodu — canlı mobil görünüme yönlendirir
  const takeawayQR = document.getElementById('takeawayQR');
  if (takeawayQR && !isMobileMode && typeof QRCode !== 'undefined') {
    takeawayQR.innerHTML = '';
    const qSize = window.innerWidth >= 1900 ? 280 : 150;
    new QRCode(takeawayQR, {
      text: getTakeawayUrl(),
      width: qSize,
      height: qSize,
      colorDark: '#0f172a',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  applySettings(settings);
  renderCampList();
  veriGetir();

  // Her 60 saniyede bir vardiya geçişini (08:30 / 18:30) ve kalan dakika sayaçlarını ağa gitmeden güncelle
  setInterval(() => {
    if (rawSchedulePool.length > 0) {
      refreshActiveShiftView(false);
    }
  }, 60 * 1000);

  // Her 5 dakikada bir sunucudan/data.json'dan olası nöbet değişikliklerini kontrol et
  setInterval(() => veriGetir(true), 5 * 60 * 1000);

  // Hava durumunu her 30 dakikada bir güncelle
  setInterval(fetchWeather, 30 * 60 * 1000);
});

window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.overlayClick = overlayClick;
window.veriGetir = veriGetir;
window.deleteCamp = deleteCamp;
window.setDistrictFilter = setDistrictFilter;
window.toggleMobileMap = toggleMobileMap;
