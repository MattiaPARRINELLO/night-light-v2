#!/usr/bin/env node
/**
 * Fondu enchaîné : le live et le show analysé sont composités sans frame noir,
 * et le show reste calé sur la position du lecteur à la fin du fondu.
 *
 *   bun tests/e2e/crossfade_check.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnApi } from "./api_process.mjs";

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

const api = spawnApi(root, API_PORT, {
  SESSION_DIR: join(workspace, "night-light-sessions"),
  CACHE_DIR: join(workspace, "night-light-cache"),
});

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
    const measuredAt = Date.now();
    const showMs = app.showTimeMs(measuredAt);
    const expectedMs = 3000 + (measuredAt - started);
    // Sortie du show vers le direct : même exigence, aucun frame noir.
    const exitStarted = Date.now();
    app.backToDrop({ fade: true, reason: "test de sortie" });
    const exitSamples = [];
    let exitEndedAt = 0;
    for (let i = 0; i < 500; i += 1) {
      const canvas = app.canvas;
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      for (let p = 0; p < data.length; p += 4 * 97) {
        if (data[p] + data[p + 1] + data[p + 2] > 18) lit += 1;
      }
      exitSamples.push(lit);
      if (app.crossfade === null && i > 2) {
        exitEndedAt = Date.now();
        break;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const liveAtEnd = app.liveMode;
    const dropVisible = document.getElementById("screen-drop")?.classList.contains("is-active") ?? false;

    // Le morceau suivant arrive AU MILIEU de la sortie vers le direct : c'est le
    // cas qui doit réorienter le fondu sans couper.
    await app.startSyncedShow(analysis, 3000);
    while (app.crossfade !== null) await new Promise((resolve) => requestAnimationFrame(resolve));
    app.backToDrop({ fade: true, reason: "test de reprise" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const repriseStarted = Date.now();
    await app.startSyncedShow(analysis, 3000);
    if (app.syncedTimer !== null) window.clearInterval(app.syncedTimer);
    app.syncedTimer = null;
    const repriseSamples = [];
    let repriseEndedAt = 0;
    for (let i = 0; i < 500; i += 1) {
      const canvas = app.canvas;
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      for (let p = 0; p < data.length; p += 4 * 97) {
        if (data[p] + data[p + 1] + data[p + 2] > 18) lit += 1;
      }
      repriseSamples.push(lit);
      if (app.crossfade === null && i > 2) {
        repriseEndedAt = Date.now();
        break;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    return {
      frames: samples.length,
      zeroFrames: samples.filter((value) => value === 0).length,
      minLit: Math.min(...samples),
      crossfadeMs: endedAt === 0 ? null : endedAt - started,
      showMs,
      expectedMs,
      exitFrames: exitSamples.length,
      exitZeroFrames: exitSamples.filter((value) => value === 0).length,
      exitMinLit: Math.min(...exitSamples),
      exitMs: exitEndedAt === 0 ? null : exitEndedAt - exitStarted,
      liveAtEnd,
      dropVisible,
      repriseFrames: repriseSamples.length,
      repriseZeroFrames: repriseSamples.filter((value) => value === 0).length,
      repriseMinLit: Math.min(...repriseSamples),
      repriseMs: repriseEndedAt === 0 ? null : repriseEndedAt - repriseStarted,
      repriseSynced: app.syncedMode,
    };
  });

  const driftMs = Math.round(result.showMs - result.expectedMs);
  console.log(
    `fondu : ${result.frames} frames · frames noirs ${result.zeroFrames} · ` +
      `luminosité min ${result.minLit} · durée ${result.crossfadeMs ?? "?"} ms · écart ${driftMs} ms`,
  );
  console.log(
    `sortie : ${result.exitFrames} frames · frames noirs ${result.exitZeroFrames} · ` +
      `luminosité min ${result.exitMinLit} · durée ${result.exitMs ?? "?"} ms · ` +
      `direct ${result.liveAtEnd ? "actif" : "inactif"} · dépôt ${result.dropVisible ? "visible" : "masqué"}`,
  );
  console.log(
    `reprise : ${result.repriseFrames} frames · frames noirs ${result.repriseZeroFrames} · ` +
      `luminosité min ${result.repriseMinLit} · durée ${result.repriseMs ?? "?"} ms · ` +
      `show ${result.repriseSynced ? "calé" : "absent"}`,
  );
  if (result.zeroFrames > 0) failures.push(`${result.zeroFrames} frame(s) entièrement noir(s)`);
  if (result.crossfadeMs === null) failures.push("le fondu ne s'est pas terminé");
  if (Math.abs(driftMs) > 150) failures.push(`position analysée décalée de ${driftMs} ms`);
  if (result.exitZeroFrames > 0) failures.push(`${result.exitZeroFrames} frame(s) noir(s) en sortie`);
  if (result.exitMs === null) failures.push("la sortie en fondu ne s'est pas terminée");
  if (!result.liveAtEnd) failures.push("le direct n'a pas repris après la sortie");
  if (!result.dropVisible) failures.push("l'écran de dépôt n'est pas revenu après la sortie");
  if (result.repriseZeroFrames > 0) failures.push(`${result.repriseZeroFrames} frame(s) noir(s) en reprise`);
  if (result.repriseMs === null) failures.push("la reprise en fondu ne s'est pas terminée");
  if (!result.repriseSynced) failures.push("le show n'a pas repris après la réorientation du fondu");
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
