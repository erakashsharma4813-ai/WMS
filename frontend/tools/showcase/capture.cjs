// Plays the showcase in headless Chrome and saves a frame every 0.7 s with the
// lower-third headline on screen, so every beat can be looked at.
//
//   npm i --no-save playwright-core
//   node tools/showcase/capture.cjs <out-dir> [replay|sim] [hero]
//
// Needs the dev server (npm run dev) and the backend running, and a local
// Chrome; set CHROME to its path if it is not in the default place.
const { chromium } = require("playwright-core");
const fs = require("fs");

const [out = "showcase-frames", mode = "replay", hero] = process.argv.slice(2);
const chrome = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const url = process.env.APP_URL ?? "http://127.0.0.1:5173/";

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector('button[title^="Showcase"]', { timeout: 60000 });
  await page.waitForTimeout(5000);
  if (mode === "sim") {
    await page.click("text=What-if");
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Run new simulation")');
    await page.waitForTimeout(12000);
  }
  await page.click('button[title^="Showcase"]');
  await page.waitForSelector(".showcase-setup");
  if (hero) await page.selectOption(".showcase-setup select", hero);
  await page.screenshot({ path: `${out}/setup.png` });
  await page.click(".showcase-actions .teal-action");
  const started = Date.now();
  let last = "";
  for (let index = 0; index < 120; index += 1) {
    await page.waitForTimeout(700);
    const title = await page.$eval(".showcase-third b", (element) => element.textContent).catch(() => null);
    if (title === null) break;
    await page.screenshot({ path: `${out}/f${String(index).padStart(3, "0")}.png` });
    if (title !== last) console.log(`f${String(index).padStart(3, "0")}  ${((Date.now() - started) / 1000).toFixed(1)} s  ${title}`);
    last = title;
  }
  if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
