// scripts/shot.js — element screenshots of the full map container
import { chromium } from "playwright";
import fs from "fs/promises";

const VIEWPORT_W = parseInt(process.env.VIEWPORT_W || "1920", 10);
const VIEWPORT_H = parseInt(process.env.VIEWPORT_H || "1200", 10);
const DEVICE_SCALE = parseFloat(process.env.DEVICE_SCALE || "2");
const STABILIZE_MS = parseInt(process.env.STABILIZE_MS || "800", 10);

const KILIMA_SELECTOR    = process.env.KILIMA_SELECTOR    || ".leaflet-container";
const BAHARI_SELECTOR    = process.env.BAHARI_SELECTOR    || ".leaflet-container";
const ELDERWOOD_SELECTOR = process.env.ELDERWOOD_SELECTOR || ".leaflet-container";

const TARGETS = [
  { url: "https://palia.th.gl/rummage-pile?map=kilima-valley", out: "docs/kilima.png",    sel: KILIMA_SELECTOR },
  { url: "https://palia.th.gl/rummage-pile?map=bahari-bay",    out: "docs/bahari.png",    sel: BAHARI_SELECTOR },
  { url: "https://palia.th.gl/rummage-pile?map=elderwood",     out: "docs/elderwood.png", sel: ELDERWOOD_SELECTOR },
];

const FALLBACKS = ["#map", ".maplibregl-map", ".leaflet-container"];

async function hideChrome(page) {
  await page.addStyleTag({ content: `
    header, nav, footer, .tabs, .tabbar, .maplibregl-control-container,
    .ad, [id*="ad"], [class*="ad"] { display:none!important; }
    body { background:#000!important; }
  `});
}

async function waitSizeStable(page, selector) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 30000 });

  let last = "";
  let stableSince = Date.now();
  const start = Date.now();

  while (Date.now() - start < 15000) {
    const box = await loc.boundingBox();
    if (!box || box.width < 200 || box.height < 150) {
      await page.waitForTimeout(120);
      continue;
    }
    const key = `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`;
    if (key === last) {
      if (Date.now() - stableSince >= STABILIZE_MS) return loc;
    } else {
      last = key;
      stableSince = Date.now();
    }
    await page.waitForTimeout(120);
  }
  return loc; // proceed even if not perfectly stable
}

async function captureMap(page, preferred) {
  let sel = preferred;
  if (!(await page.locator(sel).count())) {
    for (const fb of FALLBACKS) if (await page.locator(fb).count()) { sel = fb; break; }
  }
  const loc = await waitSizeStable(page, sel);
  await loc.scrollIntoViewIfNeeded();
  return await loc.screenshot({ type: "png", animations: "disabled" });
}

async function snapOne(url, outfile, selector) {
  const browser = await chromium.launch(); // headless
  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
      deviceScaleFactor: DEVICE_SCALE,
    });
    const page = await context.newPage();

    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
      await hideChrome(page);

      try {
        const buf = await captureMap(page, selector);
        await fs.mkdir("docs", { recursive: true });
        await fs.writeFile(outfile, buf);
        return;
      } catch (e) {
        if (attempt === 1) await page.waitForTimeout(1000);
        else throw e;
      }
    }
  } finally {
    await browser.close();
  }
}

async function run() {
  for (const t of TARGETS) {
    console.log("Shooting:", t.url, "selector:", t.sel);
    await snapOne(t.url, t.out, t.sel);
    console.log("Wrote:", t.out);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
