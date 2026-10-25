#!/usr/bin/env node
/** Capture le spectacle à plusieurs instants d'un même morceau. */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnApi } from "./api_process.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const API_PORT = 8793;
const API = `http://127.0.0.1:${API_PORT}`;
const output = process.argv[2] ?? join(root, "dist-shot");
const rich = process.argv[3] === "rich";
mkdirSync(output, { recursive: true });

const { loadChromium } = await import("./playwright.mjs");
const chromium = await loadChromium();

const workspace = mkdtempSync(join(tmpdir(), "night-light-shot-"));
const track = join(workspace, "piste.wav");
spawnSync("uv", ["run", "python", "tests/support/make_fixture.py", track, rich ? "rich" : "12.0"], {
  cwd: root,
  encoding: "utf8",
});

const api = spawnApi(root, API_PORT, {
  SESSION_DIR: join(workspace, "night-light-sessions"),
});

async function waitFor(url, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("api non démarrée");
}

async function seek(page, seconds) {
  await page.evaluate((value) => {
    document.querySelector("audio").currentTime = value;
  }, seconds);
  await page.waitForTimeout(600);
}

try {
  await waitFor(`${API}/api/health`);
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (error) => console.error("pageerror:", String(error)));
  await page.goto(`${API}/`, { waitUntil: "domcontentloaded" });
  await page.setInputFiles("#file-input", track);
  await page.waitForSelector('body[data-analysis-ready="true"]', { timeout: 120000 });
  await page.keyboard.press("s");
  await page.waitForSelector("#screen-show.is-active", { timeout: 20000 });

  const moments = rich ? [4, 20, 36, 50] : [1, 3, 5, 7.5, 10];
  for (const seconds of moments) {
    await seek(page, seconds);
    const info = await page.evaluate(() => {
      const audio = document.querySelector("audio");
      return { time: audio.currentTime, paused: audio.paused };
    });
    await page.screenshot({ path: join(output, `show-${String(seconds).replace(".", "_")}s.png`) });
    console.log(`capture ${seconds}s (position ${info.time.toFixed(2)}s, ${info.paused ? "pause" : "lecture"})`);
  }

  await page.screenshot({ path: join(output, "hud.png") });
  await page.locator("#hud").screenshot({ path: join(output, "hud-only.png") });
  await page.click("#btn-change-track");
  await page.waitForSelector("#screen-drop.is-active");
  await page.screenshot({ path: join(output, "drop.png") });
  console.log(`captures dans ${output}`);
  await browser.close();
} finally {
  try {
    process.kill(-api.pid);
  } catch {
    api.kill();
  }
}
