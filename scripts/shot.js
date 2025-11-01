// scripts/shot.js — pick the largest *visible* Leaflet container and screenshot it
import { chromium } from "playwright";
import fs from "fs/promises";

const VIEWPORT_W   = parseInt(process.env.VIEWPORT_W   || "1920", 10);
const VIEWPORT_H   = parseInt(process.env.VIEWPORT_H   || "1200", 10);
const DEVICE_SCALE = parseFloat(process.env.DEVICE_SCALE || "2");
const STABILIZE_MS = parseInt(process.env.STABILIZE_MS || "1200", 10);

const TARGETS = [
  { url: "https://palia.th.gl/rummage-pile?map=kilima-valley", tabText: "Kilima Valley", out: "docs/kilima.png" },
  { url: "https://palia.th.gl/rummage-pile?map=bahari-bay",    tabText: "Bahari Bay",   out: "docs/bahari.png" },
  { url: "https://palia.th.gl/rummage-pile?map=elderwood",     tabText: "Elderwood",    out: "docs/elderwood.png" },
];

async function hideChrome(page) {
  await page.addStyleTag({ content: `
    header, nav, footer, .tabs, .tabbar, .maplibregl-control-container,
    .ad, [id*="ad"], [class*="ad"] { display:none!important; }
    body { background:#000!important; }
  `});
}

// Click the correct tab if the site renders tabs
async function clickTabIfPresent(page, text) {
  const tab = page.getByRole("tab", { name: text }).first();
  if (await tab.count()) {
    await tab.click().catch(()=>{});
  }
}

// Return a locator for the largest *visible* .leaflet-container on the page
async function largestVisibleLeaflet(page, stableMs) {
  const start = Date.now();
  let stableSince = Date.now();
  let lastKey = "";

  // Try up to ~12s to let layout settle
  while (Date.now() - start < 12000) {
    const idx = await page.evaluate(() => {
      const isVisible = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 200 && r.height > 150 && r.bottom > 0 && r.right > 0;
      };
      const els = Array.from(document.querySelectorAll(".leaflet-container"));
      let best = { i: -1, area: 0, rect: null };
      els.forEach((el, i) => {
        if (!isVisible(el)) return;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > best.area) best = { i, area, rect: { x:r.x, y:r.y, w:r.width, h:r.height } };
      });
      return best.i;
    });

    if (idx >= 0) {
      // wait for size to be stable
      const key = await page.evaluate((i) => {
        const el = document.querySelectorAll(".leaflet-container")[i];
        if (!el) return "";
        const r = el.getBoundingClientRect();
        return `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.width)}:${Math.round(r.height)}`;
      }, idx);

      if (key === lastKey) {
        if (Date.now() - stableSince >= stableMs) {
          return page.locator(".leaflet-container").nth(idx);
        }
      } else {
        lastKey = key;
        stableSince = Date.now();
      }
    }

    await page.waitForTimeout(150);
  }

  // Fallback to first Leaflet container (might still work)
  const any = page.locator(".leaflet-container").first();
  if (await any.count()) return any;
  return null;
}

async function snapOne({ url, tabText, out }) {
  const browser = await chromium.launch(); // headless
  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
      deviceScaleFactor: DEVICE_SCALE
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    await hideChrome(page);
    await clickTabIfPresent(page, tabText);

    const target = await largestVisibleLeaflet(page, STABILIZE_MS);
    if (!target) throw new Error("No visible .leaflet-container found.");

    await target.scrollIntoViewIfNeeded();
    const buf = await target.screenshot({ type: "png", animations: "disabled" });

    await fs.mkdir("docs", { recursive: true });
    await fs.writeFile(out, buf);
    console.log("Wrote:", out);
  } finally {
    await browser.close();
  }
}

async function run() {
  for (const t of TARGETS) {
    console.log("Shooting:", t.url);
    await snapOne(t);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
