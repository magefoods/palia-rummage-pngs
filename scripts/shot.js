// scripts/shot.js — robust "union-of-map-layers" crop (no missing edges)
import { chromium } from "playwright";
import fs from "fs/promises";

const VIEWPORT_W = parseInt(process.env.VIEWPORT_W || "1600", 10);
const VIEWPORT_H = parseInt(process.env.VIEWPORT_H || "1000", 10);
const DEVICE_SCALE = parseFloat(process.env.DEVICE_SCALE || "2"); // crisp PNGs
const PADDING = parseInt(process.env.MAP_PADDING || "8", 10);     // extra pixels around map

const TARGETS = [
  { url: "https://palia.th.gl/rummage-pile?map=kilima-valley", out: "docs/kilima.png" },
  { url: "https://palia.th.gl/rummage-pile?map=bahari-bay",    out: "docs/bahari.png" },
  { url: "https://palia.th.gl/rummage-pile?map=elderwood",     out: "docs/elderwood.png" },
];

// Everything that could be part of the visible map (canvases, grid, tiles, panes)
const MAP_LAYER_SELECTORS = [
  ".maplibregl-canvas",
  ".maplibregl-canvas-container",
  ".maplibregl-layer",            // some themes add this
  ".leaflet-pane",
  ".leaflet-layer",
  "#map canvas",
  "#map .leaflet-pane",
  "canvas"                        // final fallback
];

// Elements we explicitly want to exclude from the crop
const EXCLUDE_SELECTORS = [
  "header", "nav", "footer",
  ".tabs", ".tabbar",
  ".maplibregl-control-container", // zoom controls, attribution, etc.
];

async function hideChrome(page) {
  // Hide obvious non-map chrome so it doesn't expand our union rect
  await page.addStyleTag({ content: `
    ${EXCLUDE_SELECTORS.join(",")} {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
    }
    body { background: #000 !important; }
  `});
}

/**
 * Compute the union bounding box of all relevant map layers.
 * Returns {x, y, width, height} in CSS pixels (not dpr-scaled).
 */
async function getTightMapRect(page) {
  // Wait until at least one canvas is there
  await page.waitForSelector("canvas", { state: "visible", timeout: 30_000 });

  return await page.evaluate(({ MAP_LAYER_SELECTORS, EXCLUDE_SELECTORS, PADDING }) => {
    // Helper: is element excluded?
    const isExcluded = (el) => {
      return EXCLUDE_SELECTORS.some(sel => el.closest(sel));
    };

    // Collect rects
    const rects = [];
    for (const sel of MAP_LAYER_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const el of nodes) {
        if (!(el instanceof HTMLElement)) continue;
        if (!el.offsetParent) continue;              // not visible/attached
        if (isExcluded(el)) continue;

        const r = el.getBoundingClientRect();
        if (r.width >= 100 && r.height >= 80) {      // ignore tiny bits
          rects.push(r);
        }
      }
    }

    if (!rects.length) {
      // As a last resort, use the viewport (caller will handle)
      return null;
    }

    // Union
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rects) {
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right);
      maxY = Math.max(maxY, r.bottom);
    }

    // Pad a bit to avoid tight clipping on borders
    minX = Math.max(0, Math.floor(minX) - PADDING);
    minY = Math.max(0, Math.floor(minY) - PADDING);
    maxX = Math.ceil(maxX) + PADDING;
    maxY = Math.ceil(maxY) + PADDING;

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }, { MAP_LAYER_SELECTORS, EXCLUDE_SELECTORS, PADDING });
}

async function snapOne(url, outfile) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
      deviceScaleFactor: DEVICE_SCALE,
    });
    const page = await context.newPage();

    // Two attempts in case late layout changes size
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 });
      await hideChrome(page);

      const rect = await getTightMapRect(page);

      if (rect && rect.width > 0 && rect.height > 0) {
        // Ensure viewport can fully contain our clip rectangle
        const needW = Math.max(VIEWPORT_W, Math.ceil(rect.x + rect.width) + 1);
        const needH = Math.max(VIEWPORT_H, Math.ceil(rect.y + rect.height) + 1);
        await page.setViewportSize({ width: needW, height: needH });

        // Scroll so top-left of clip is in view (Playwright requires clip to be within the page)
        await page.mouse.wheel(0, -99999);
        await page.evaluate((x, y) => window.scrollTo({ left: 0, top: 0 }));
        // No-op if page isn't scrollable, that's fine.

        const buf = await page.screenshot({
          type: "png",
          clip: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          animations: "disabled",
        });

        await fs.mkdir("docs", { recursive: true });
        await fs.writeFile(outfile, buf);
        return;
      }

      // Fallback (first attempt only): wait and retry once
      if (attempt === 1) await page.waitForTimeout(2000);
    }

    // Absolute fallback: element screenshot of the biggest canvas
    const biggestCanvas = page.locator("canvas").first();
    const buf = await biggestCanvas.screenshot({ type: "png", animations: "disabled" });
    await fs.mkdir("docs", { recursive: true });
    await fs.writeFile(outfile, buf);
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
