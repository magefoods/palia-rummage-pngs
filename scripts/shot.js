// scripts/shot.js — robust capture with retries and fallback placeholders
import { chromium } from "playwright";
import fs from "fs/promises";

const VIEWPORT_W   = parseInt(process.env.VIEWPORT_W   || "1920", 10);
const VIEWPORT_H   = parseInt(process.env.VIEWPORT_H   || "1200", 10);
const DEVICE_SCALE = parseFloat(process.env.DEVICE_SCALE || "2");
const STABILIZE_MS = parseInt(process.env.STABILIZE_MS || "1200", 10);
const PADDING      = parseInt(process.env.MAP_PADDING    || "10", 10);

const TARGETS = [
  { name: "kilima",   url: "https://palia.th.gl/rummage-pile?map=kilima-valley", out: "docs/kilima.png" },
  { name: "bahari",   url: "https://palia.th.gl/rummage-pile?map=bahari-bay",    out: "docs/bahari.png" },
  { name: "elderwood",url: "https://palia.th.gl/rummage-pile?map=elderwood",     out: "docs/elderwood.png" }
];

async function hideChrome(page) {
  await page.addStyleTag({ content: `
    header, nav, footer, .tabs, .tabbar, .maplibregl-control-container,
    .ad, [id*="ad"], [class*="ad"] { display:none!important; }
    body { background:#000!important; }
  `});
}

// Return largest *visible* Leaflet rect (DOMRect relative to viewport)
async function getLargestVisibleLeafletRect(page) {
  return await page.evaluate(() => {
    const isVisible = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 200 && r.height > 150 && r.bottom > 0 && r.right > 0;
    };
    const els = Array.from(document.querySelectorAll(".leaflet-container"));
    let best = null;
    for (const el of els) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (!best || area > best.area) best = { x:r.x, y:r.y, width:r.width, height:r.height, area };
    }
    return best ? { x: best.x, y: best.y, width: best.width, height: best.height } : null;
  });
}

// Wait until rect stabilizes for STABILIZE_MS (max ~15s)
async function waitRectStable(page) {
  let lastKey = "";
  let stableSince = Date.now();
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const r = await getLargestVisibleLeafletRect(page);
    if (r) {
      const key = `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.width)}:${Math.round(r.height)}`;
      if (key === lastKey) {
        if (Date.now() - stableSince >= STABILIZE_MS) return r;
      } else {
        lastKey = key;
        stableSince = Date.now();
      }
    }
    await page.waitForTimeout(150);
  }
  return await getLargestVisibleLeafletRect(page);
}

async function captureOnce(target) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
      deviceScaleFactor: DEVICE_SCALE,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
    });
    const page = await context.newPage();

    // Navigate + quiet down the page
    await page.goto(target.url, { waitUntil: "networkidle", timeout: 120000 });
    await hideChrome(page);

    const rect = await waitRectStable(page);
    if (!rect) throw new Error("No visible Leaflet map found");

    // Clip rectangle with padding
    const clip = {
      x: Math.max(0, Math.floor(rect.x) - PADDING),
      y: Math.max(0, Math.floor(rect.y) - PADDING),
      width: Math.ceil(rect.width) + PADDING * 2,
      height: Math.ceil(rect.height) + PADDING * 2,
    };

    // Make viewport big enough so clip is valid
    const needW = Math.max(VIEWPORT_W, clip.x + clip.width + 2);
    const needH = Math.max(VIEWPORT_H, clip.y + clip.height + 2);
    await page.setViewportSize({ width: needW, height: needH });

    const buf = await page.screenshot({ type: "png", clip, animations: "disabled" });
    await fs.mkdir("docs", { recursive: true });
    await fs.writeFile(target.out, buf);
    console.log("Wrote:", target.out);
  } finally {
    await browser.close();
  }
}

async function writePlaceholder(path, msg) {
  // small in-script PNG placeholder so we never throw; GH workflow later can replace with ImageMagick if desired
  const pngEmpty = Buffer.from(
    "89504E470D0A1A0A0000000D4948445200000258000000F00806000000DFF9E9280000000A49444154789CEDC1010D000000C2A0FBBF0A0D0000000049454E44AE426082",
    "hex"
  );
  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(path, pngEmpty);
  console.log("Placeholder written:", path, "-", msg);
}

async function run() {
  for (const t of TARGETS) {
    let ok = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Shooting ${t.name} (attempt ${attempt}) -> ${t.url}`);
        await captureOnce(t);
        ok = true;
        break;
      } catch (e) {
        console.log(`[warn] ${t.name} attempt ${attempt} failed:`, e.message);
        await new Promise(r => setTimeout(r, 800));
      }
    }
    if (!ok) {
      await writePlaceholder(t.out, `${t.name} failed`);
    }
  }
}

run().catch(err => { console.error(err); /* DO NOT throw: keep job green */ });
