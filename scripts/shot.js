// scripts/shot.js
// Takes 3 screenshots from palia.th.gl and ensures the whole map is visible.
// - Zooms the MAP UI itself (wheel + Ctrl+- fallback)
// - Optionally shrinks page via CSS zoom
// - Hides common overlays
// - Validates PNG bytes before committing

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = path.join(__dirname, '..', 'docs');
const SHOTS = [
  { name: 'kilima.png',    url: 'https://palia.th.gl/rummage-pile?map=kilima-valley' },
  { name: 'bahari.png',    url: 'https://palia.th.gl/rummage-pile?map=bahari-bay' },
  { name: 'elderwood.png', url: 'https://palia.th.gl/rummage-pile?map=elderwood' },
];

const MIN_BYTES = 50_000; // sanity threshold to avoid committing corrupt images

function isValidPng(buf) {
  if (!buf || buf.length < 100) return false;
  const sig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  return buf.subarray(0, 8).equals(sig);
}

// Try to locate the map element (covers Leaflet, Mapbox GL, canvases, etc.)
async function findMapLocator(page) {
  const sel = [
    '.leaflet-container',
    '.mapboxgl-canvas',
    '.mapboxgl-map',
    '#map',
    '.map',
    'canvas'
  ].join(', ');
  const loc = page.locator(sel).first();
  await loc.waitFor({ state: 'visible', timeout: 20_000 });
  return loc;
}

// Zoom OUT using mouse wheel, centered on the element
async function zoomOutWheel(page, mapLoc, steps = 12, delta = -1500) {
  const box = await mapLoc.boundingBox();
  if (!box) throw new Error('Map element has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, delta); // negative = zoom OUT on most map libs
    await page.waitForTimeout(200);
  }
}

// Fallback zoom OUT using Ctrl + '-' keypresses (helps when wheel is blocked)
async function zoomOutCtrlMinus(page, presses = 8) {
  await page.keyboard.down('Control'); // works on Linux runners; ok for site UIs too
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('-');
    await page.waitForTimeout(120);
  }
  await page.keyboard.up('Control');
}

// Remove visual clutter that may overlap the map
async function hideOverlays(page) {
  await page.addStyleTag({
    content: `
      .leaflet-control, .mapboxgl-ctrl, [class*="control"] { opacity: 0 !important; pointer-events: none !important; }
      .leaflet-bottom.leaflet-right, .mapboxgl-ctrl-bottom-right { display: none !important; }
      [class*="attribution"], .mapboxgl-ctrl-logo { display: none !important; }
    `
  });
}

// Optional: shrink the whole page (fits even more of the map in the same element box)
async function applyPageZoom(page, factor = 0.8) {
  await page.evaluate((f) => { document.documentElement.style.zoom = String(f); }, factor);
  await page.waitForTimeout(200);
}

(async () => {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { width: 2200, height: 1400 },
  });
  const page = await ctx.newPage();

  for (const { name, url } of SHOTS) {
    console.log(`[shot] ${name} ← ${url}`);

    // 1) Open & let network settle
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(1500);

    // 2) Find the map element
    const mapLoc = await findMapLocator(page);

    // 3) Make the viewport roomy
    await page.setViewportSize({ width: 2400, height: 1500 });

    // 4) Try zooming the MAP UI out aggressively
    try {
      await zoomOutWheel(page, mapLoc, 14, -1800);
    } catch (e) {
      console.warn('[shot] wheel zoom failed, trying Ctrl+- fallback:', e.message);
      await zoomOutCtrlMinus(page, 10);
    }

    // 5) Optional page zoom (squeeze page to fit even more)
    await applyPageZoom(page, 0.75);

    // 6) Hide overlays/controls so the PNG is clean
    await hideOverlays(page);

    // 7) Screenshot **the map element** (not the whole page)
    const buf = await mapLoc.screenshot({ type: 'png', animations: 'disabled' });

    // 8) Validate and write
    if (!isValidPng(buf) || buf.length < MIN_BYTES) {
      throw new Error(`Refusing to write ${name}: invalid/too-small PNG (len=${buf?.length ?? 0})`);
    }
    const outPath = path.join(OUTDIR, name);
    fs.writeFileSync(outPath, buf); // binary write
    console.log(`[ok] wrote ${outPath} (${buf.length} bytes)`);
  }

  await browser.close();
})().catch(err => {
  console.error('[shot] failed:', err);
  process.exit(1);
});
