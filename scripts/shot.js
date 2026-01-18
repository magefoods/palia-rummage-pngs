// scripts/shot.js
// Screenshot the visible map area for 3 regions—no scrolling/zooming.
// Robust navigation (no networkidle), render-aware waits, and element-clip capture.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = path.join(__dirname, '..', 'docs');
const SHOTS = [
  { name: 'kilima.png',    url: 'https://palia.th.gl/rummage-pile?map=kilima-valley' },
  { name: 'bahari.png',    url: 'https://palia.th.gl/rummage-pile?map=bahari-bay' },
  { name: 'elderwood.png', url: 'https://palia.th.gl/rummage-pile?map=elderwood' },
];

const MIN_BYTES = 20_000;

function isValidPng(buf) {
  if (!buf || buf.length < 100) return false;
  const sig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  return buf.subarray(0, 8).equals(sig);
}

// Wait until tiles/canvas are drawn (generic heuristic)
async function waitForMapRender(page, timeout = 25_000) {
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll('img')).filter(i =>
      i.naturalWidth > 0 &&
      i.naturalHeight > 0 &&
      i.offsetParent !== null &&
      /(tile|map|leaflet|mapbox|raster|png|jpg)/i.test(i.src || '')
    );
    if (imgs.length >= 4) return true;
    const canvases = Array.from(document.querySelectorAll('canvas'))
      .filter(c => c.width >= 800 && c.height >= 600 && c.offsetParent !== null);
    return canvases.length > 0;
  }, { timeout });
}

// Return a clip rect {x,y,width,height} for the (hopefully) only canvas on the page
async function getMapClip(page) {
  const rect = await page.evaluate(() => {
    const container = document.querySelector('canvas');
    return container.getBoundingClientRect();
  });

  if (!rect) throw new Error('Could not find a map element to clip');

  // Playwright requires integers and clip must be within the viewport
  return {
    x: Math.floor(rect.x),
    y: Math.floor(rect.y),
    width: Math.floor(rect.width),
    height: Math.floor(rect.height),
  };
}

// Retry navigation without relying on "networkidle"
async function gotoRetry(page, url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(1500 * (i + 1));
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
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 RummageBot/1.0',
  });

  const page = await ctx.newPage();

  // Optional: block analytics/fonts that can hang requests
  await page.route('**/*', route => {
    const u = route.request().url();
    if (/\.(woff2?|ttf|otf)$/.test(u) || /google-analytics|googletag|gtag|segment|sentry/i.test(u)) {
      return route.abort();
    }
    return route.continue();
  });

  for (const { name, url } of SHOTS) {
    console.log(`[shot] ${name} ← ${url}`);

    await gotoRetry(page, url, 3);
    await waitForMapRender(page, 25_000);
    await page.waitForTimeout(5000);

    const clip = await getMapClip(page);

    const buf = await page.screenshot({
      type: 'png',
      animations: 'disabled',
      clip, // <— capture just the map element
    });

    if (!isValidPng(buf) || buf.length < MIN_BYTES) {
      throw new Error(`Refusing to write ${name}: invalid/too-small PNG (len=${buf?.length ?? 0})`);
    }

    const outPath = path.join(OUTDIR, name);
    fs.writeFileSync(outPath, buf);
    console.log(`[file] wrote ${outPath} (${buf.length} bytes)`);
  }

  await browser.close();
})().catch(err => {
  console.error('[shot] failed:', err);
  process.exit(1);
});
