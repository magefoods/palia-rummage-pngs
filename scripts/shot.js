// scripts/shot.js
import { chromium } from "playwright";
import fs from "fs/promises";

const VIEWPORT_W = parseInt(process.env.VIEWPORT_W || "1600", 10);
const VIEWPORT_H = parseInt(process.env.VIEWPORT_H || "1000", 10);
const DEVICE_SCALE = parseFloat(process.env.DEVICE_SCALE || "1.5"); // sharper output

// TH.GL targets
const TARGETS = [
  { url: "https://palia.th.gl/rummage-pile?map=kilima-valley", out: "docs/kilima.png" },
  { url: "https://palia.th.gl/rummage-pile?map=bahari-bay",    out: "docs/bahari.png" },
  { url: "https://palia.th.gl/rummage-pile?map=elderwood",     out: "docs/elderwood.png" },
];

// Candidate selectors that typically represent the map area
const CANDIDATES = [
  "canvas.maplibregl-canvas",      // MapLibre / maplibre-gl
  ".maplibregl-canvas",
  "#map canvas",
  "#map",
  ".leaflet-pane .leaflet-layer",  // Leaflet fallback
  ".leaflet-pane",
  "main canvas",
  "canvas"
];

// Find the biggest visible candidate element and screenshot just that.
// Falls back to full page if nothing good is found.
async function screenshotMapArea(page) {
  // wait for the page to be mostly idle
  await page.waitForLoadState("networkidle", { timeout: 60_000 });

  // try selector list first
  for (const sel of CANDIDATES) {
    const loc = page.locator(sel).first();
    const count = await loc.count();
    if (!count) continue;

    try {
      await loc.waitFor({ state: "visible", timeout: 10_000 });
      const handle = await loc.elementHandle();
      // make sure it's on screen
      await handle.scrollIntoViewIfNeeded();
      return await loc.screenshot({ type: "png" });
    } catch (_) {
      // try next selector
    }
  }

  // fallback: pick the largest visible <canvas> by area
  const handles = await page.$$("canvas");
  let best = null, bestBox = null;
  for (const h of handles) {
    const box = await h.boundingBox();
    if (!box) continue;
    const area = box.width * box.height;
    if (box.width >= 400 && box.height >= 300 && (!best || area > bestBox.width * bestBox.height)) {
      best = h; bestBox = box;
    }
  }
  if (best) {
    await best.scrollIntoViewIfNeeded();
    return await best.screenshot({ type: "png" });
  }

  // last resort: full page
  return await page.screenshot({ fullPage: true, type: "png" });
}

async function snapOne(url, outfile) {
  const browser = await chromium.launch(); // headless
  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
      deviceScaleFactor: DEVICE_SCALE,
    });
    const page = await context.newPage();

    // navigate & crop (with one retry)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 });
        const buf = await screenshotMapArea(page);
        await fs.mkdir("docs", { recursive: true });
        await fs.writeFile(outfile, buf);
        return;
      } catch (e) {
        if (attempt === 2) throw e;
        // small wait then retry once
        await page.waitForTimeout(2000);
      }
    }
  } finally {
    await browser.close();
  }
}

async function run() {
  for (const t of TARGETS) {
    console.log("Shooting:", t.url);
    await snapOne(t.url, t.out);
    console.log("Wrote:", t.out);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
