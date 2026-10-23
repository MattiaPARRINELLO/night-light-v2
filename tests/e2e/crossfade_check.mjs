#!/usr/bin/env node
/**
 * Fondu enchaîné : le live et le show analysé sont composités sans frame noir,
 * et le show reste calé sur la position du lecteur à la fin du fondu.
 *
 *   bun tests/e2e/crossfade_check.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const API_PORT = 8848;
const API = `http://127.0.0.1:${API_PORT}`;
const { loadChromium } = await import("./playwright.mjs");
const chromium = await loadChromium();
const failures = [];

const workspace = mkdtempSync(join(tmpdir(), "night-light-crossfade-"));
const track = join(workspace, "Crossfade.wav");
spawnSync("uv", ["run", "python", "tests/support/make_fixture.py", track, "12.0"], {
  cwd: root,
  encoding: "utf8",
});
if (!existsSync(track)) throw new Error("impossible de générer la piste de test");

const api = spawn(
  ".venv/bin/uvicorn",
  ["server.main:app", "--host", "127.0.0.1", "--port", String(API_PORT)],
  {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      SESSION_DIR: join(workspace, "night-light-sessions"),
      PORT: String(API_PORT),
      CACHE_DIR: join(workspace, "night-light-cache"),
    },
    detached: true,
  },
);

async function waitForApi(url, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // pas encore prêt
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${url} n'a pas démarré`);
}

try {
  await waitForApi(`${API}/api/health`);
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  page.on("pageerror", (error) => failures.push(`erreur de page : ${String(error)}`));
  await page.goto(`${API}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.nightLight !== "undefined");
  await page.setInputFiles("#file-input", track);
  await page.waitForFunction(() => document.body.dataset.analysisReady === "true", null, {
    timeout: 120000,
  });

  const result = await page.evaluate(async () => {
    const app = window.nightLight;
    const analysis = app.pendingAnalysis;
    // Isole du lecteur MPRIS réel de la machine.
    app.nowPlayingStream?.close();
    app.nowPlayingStream = null;
    if (app.nowPlayingWatchdog !== null) window.clearInterval(app.nowPlayingWatchdog);
    app.nowPlayingWatchdog = null;
    app.stopNowPlayingPolling();
    app.resolveSeq += 1;
    app.analysisController?.abort();
    app.analysisController = null;
    app.syncAttemptSeq += 1;
    app.transitionMode = "crossfade";
    app.pendingTitle = "Crossfade";
    const started = Date.now();
    await app.startSyncedShow(analysis, 3000);
    if (app.syncedTimer !== null) window.clearInterval(app.syncedTimer);
    app.syncedTimer = null;
    const samples = [];
    let endedAt = 0;
    for (let i = 0; i < 500; i += 1) {
      const canvas = app.canvas;
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      for (let p = 0; p < data.length; p += 4 * 97) {
        if (data[p] + data[p + 1] + data[p + 2] > 18) lit += 1;
      }
      samples.push(lit);
      if (app.crossfade === null && i > 5) {
        endedAt = Date.now();
        break;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const showMs = app.showTimeMs(Date.now());
    return {
      frames: samples.length,
      zeroFrames: samples.filter((value) => value === 0).length,
      minLit: Math.min(...samples),
      crossfadeMs: endedAt === 0 ? null : endedAt - started,
      showMs,
      expectedMs: 3000 + (Date.now() - started),
    };
  });

  const driftMs = Math.round(result.showMs - result.expectedMs);
  console.log(
    `fondu : ${result.frames} frames · frames noirs ${result.zeroFrames} · ` +
      `luminosité min ${result.minLit} · durée ${result.crossfadeMs ?? "?"} ms · écart ${driftMs} ms`,
  );
  if (result.zeroFrames > 0) failures.push(`${result.zeroFrames} frame(s) entièrement noir(s)`);
  if (result.crossfadeMs === null) failures.push("le fondu ne s'est pas terminé");
  if (Math.abs(driftMs) > 150) failures.push(`position analysée décalée de ${driftMs} ms`);
  await browser.close();
} catch (error) {
  failures.push(`exception : ${error && error.stack ? error.stack : String(error)}`);
} finally {
  try {
    process.kill(-api.pid);
  } catch {
    api.kill();
  }
}

if (failures.length > 0) {
  console.error("\nÉCHECS :");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("\nFondu enchaîné : tout est vert.");
