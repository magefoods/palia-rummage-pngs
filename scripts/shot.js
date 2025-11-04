// scripts/shot.js
// Screenshot the visible map area for 3 regions—no scrolling/zooming.
// Robust navigation (no networkidle), render-aware waits, and retries.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = path.join(__dirname, '..', 'docs');
const SHOTS = [
  { name: 'kilima.png',    url: 'https://palia.th.gl/rummage-pile?map=kilima-valley' },
  { name: 'bahari.png',    url: 'https://palia.th.gl/rummage-pile?map=bahari-bay' },
  { name: 'elderwood.png', url: 'https://palia.th.gl/rummage-pile?map=elderwood' },
];

// Guard against corrupt/HTML screenshots
const MIN_BYTES = 20_000;

function isValidPng(buf) {
  if (!buf || buf.length < 100) return false;
  const sig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  return buf.subarray(0, 8).equals(sig);
}

// Wait until tiles/canvas are actually drawn (generic heuristic)
async function waitForMapRender(page, timeout = 25_000) {
  await page.waitForFunction(() => {
    // loaded map tiles
    const imgs = Array.from(document.querySelectorAll('img')).filter(i =>
      i.naturalWidth > 0 &&
      i.naturalHeight > 0 &&
      i.offsetParent !== null &&
      /(tile|map|leaflet|mapbox|raster|png|jpg)/i.test(i.src || '')
    );
    if (imgs.length >= 4) return true;

    // large visible canvas also counts
    const canvases = Array.from(document.querySelectorAll('canvas'))
      .filter(c => c.width >= 800 && c.height >= 600 && c.offsetParent !== null);
    return canvases.length > 0;
  }, { timeout });
}

// Choose the largest likely "map" element to screenshot
async function getMapLocator(page) {
  const candidates = [
    '.leaflet-container',
    '.mapboxgl-map',
    '.mapboxgl-canvas',
    '#map',
    '.map',
    'main',
    'canvas',
    'img'
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      try {
        await loc.waitFor({ state: 'visible', timeout: 3000 });
        const box = await loc.boundingBox();
        if (box && box.width >= 600 && box.height >= 400) return loc;
      } catch {}
    }
  }
  // Fallback: biggest visible canvas/img
  const handle = await page.evaluateHandle(() => {
    const els = Array.from(document.querySelectorAll('canvas, img'))
      .filter(e => e.offsetParent !== null);
    let best = null, bestArea = 0;
    for (const e of els) {
      const r = e.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = e; bestArea = area; }
    }
    return best;
  });
  if (!handle) throw new Error('Could not find a map element to screenshot');
  return page.locator('canvas, img').filter({ has: handle });
}

// Retry wrapper for flaky navigations (no networkidle)
async function gotoRetry(page, url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      // Give the page a brief moment to finish late scripts
      await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
      return;
    } catch (e) {
      lastErr = e;
      const backoff = 1500 * (i + 1);
      console.warn(`[gotoRetry] attempt ${i + 1} failed: ${e.message} — waiting ${backoff}ms`);
      await page.waitForTimeout(backoff);
    }
  }
  throw lastErr;
}

(async () => {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { width: 2200, height: 1400 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 RummageBot/1.0',
  });

  // Optional: block analytics/fonts to avoid long-hanging requests
  const page = await ctx.newPage();
  await page.route('**/*', route => {
    const url = route.request().url();
    if (/\.(woff2?|ttf|otf)$/.test(url) || /google-analytics|googletag|gtag|segment|sentry/i.test(url)) {
      return route.abort();
    }
    return route.continue();
  });

  for (const { name, url } of SHOTS) {
    console.log(`[shot] ${name} ← ${url}`);

    // 1) Navigate (no networkidle), with retries
    await gotoRetry(page, url, 3);

    // 2) Wait for map render heuristics
    await waitForMapRender(page, 25_000);
    await page.waitForTimeout(300); // tiny settle

    // 3) Get the map element
    const mapLoc = await getMapLocator(page);

    // Optional: hide controls so only map area is captured
    await page.addStyleTag({ content: `
      .leaflet-control, .mapboxgl-ctrl, [class*="control"] { opacity: 0 !important; pointer-events: none !important; }
      .leaflet-bottom.leaflet-right, .mapboxgl-ctrl-bottom-right { display: none !important; }
    `});

    // 4) Screenshot element
    const buf = await mapLoc.screenshot({ type: 'png', animations: 'disabled' });

    // 5) Validate & write
    if (!isValidPng(buf) || buf.length < MIN_BYTES) {
      throw new Error(`Refusing to write ${name}: invalid/too-small PNG (len=${buf?.length ?? 0})`);
    }
    const outPath = path.join(OUTDIR, name);
    fs.writeFileSync(outPath, buf);
    console.log(`[ok] wrote ${outPath} (${buf.length} bytes)`);
  }

  await browser.close();
})().catch(err => {
  console.error('[shot] failed:', err);
  process.exit(1);
});
