#!/usr/bin/env node
/**
 * Analyse en 2 passes : bascule rapide sur l'analyse partielle, puis
 * remplacement par le plan final sans frame noir ni saut de position.
 *
 *   bun tests/e2e/partial_check.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnApi } from "./api_process.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const API_PORT = 8849;
const API = `http://127.0.0.1:${API_PORT}`;
const { loadChromium } = await import("./playwright.mjs");
const chromium = await loadChromium();
const failures = [];

const workspace = mkdtempSync(join(tmpdir(), "night-light-partial-"));
const track = join(workspace, "Partial.wav");
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
    const final = app.pendingAnalysis;
    // Analyse partielle simulée : même morceau, fenêtre autour de la position,
    // tempo volontairement doublé pour vérifier l'alignement sur le tempo final.
    const partial = {
      ...final,
      coverage: [2.5, 7.5],
      tempo: final.tempo * 2,
      beatPeriod: final.beatPeriod / 2,
    };
    // Le test ne dépend pas du lecteur MPRIS réel de la machine.
    app.nowPlayingStream?.close();
    app.nowPlayingStream = null;
    if (app.nowPlayingWatchdog !== null) window.clearInterval(app.nowPlayingWatchdog);
    app.nowPlayingWatchdog = null;
    app.stopNowPlayingPolling();
    app.nowPlaying = null;
    app.resolveSeq += 1;
    app.analysisController?.abort();
    app.analysisController = null;
    app.syncAttemptSeq += 1;
    app.transitionMode = "crossfade";
    app.pendingTitle = "Partial";
    // Annule le calage automatique lancé par le dépôt du fichier.
    app.syncAttemptSeq += 1;
    app.pendingAnalysis = null;
    const started = Date.now();
    await app.startSyncedShow(partial, 3000);
    // Le test ne dépend pas du lecteur MPRIS réel : on coupe le resync qui
    // ramènerait en Live parce que le titre du fichier ne correspond à rien.
    if (app.syncedTimer !== null) window.clearInterval(app.syncedTimer);
    app.syncedTimer = null;
    while (app.trackTimings?.firstFrameMs == null && Date.now() - started < 5000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const firstFrameMs = Date.now() - started;
    const partialSeed = app.syncedPlan.seed;

    const samples = [];
    const sample = () => {
      const canvas = app.canvas;
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      for (let p = 0; p < data.length; p += 4 * 97) {
        if (data[p] + data[p + 1] + data[p + 2] > 18) lit += 1;
      }
      samples.push(lit);
    };
    app.updateSyncedAnalysis(final);
    while ((app.pendingSynced !== null || app.syncedPlan.coverage !== undefined) && Date.now() - started < 25000) {
      sample();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    sample();
    return {
      firstFrameMs,
      partialSeed,
      finalSeed: app.syncedPlan.seed,
      coverageFinal: app.syncedPlan.coverage ?? null,

      frames: samples.length,
      zeroFrames: samples.filter((value) => value === 0).length,
      showMs: app.showTimeMs(Date.now()),
      expectedMs: 3000 + (Date.now() - started),
    };
  });

  const driftMs = Math.round(result.showMs - result.expectedMs);
  console.log(
    `partiel → premier frame ${result.firstFrameMs} ms · ` +
      `remplacement : ${result.frames} frames, ${result.zeroFrames} noir(s) · ` +
      `graine ${result.partialSeed === result.finalSeed ? "identique" : "DIFFÉRENTE"} · ` +
      `couverture finale ${result.coverageFinal === null ? "complète" : result.coverageFinal} · ` +
      `écart ${driftMs} ms` ,
  );
  if (result.firstFrameMs >= 2000) failures.push(`bascule partielle trop lente : ${result.firstFrameMs} ms`);
  if (result.zeroFrames > 0) failures.push(`${result.zeroFrames} frame(s) noir(s) pendant le remplacement`);
  if (result.partialSeed !== result.finalSeed) failures.push("la graine du plan a changé");
  if (result.coverageFinal !== null) failures.push("le plan final est resté partiel");
  if (Math.abs(driftMs) > 150) failures.push(`position finale décalée de ${driftMs} ms`);
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
console.log("\nAnalyse en 2 passes : tout est vert.");
