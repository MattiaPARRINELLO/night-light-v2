#!/usr/bin/env node
/**
 * Vérification navigateur de bout en bout (Playwright headless).
 *
 *   bun run check:browser
 *
 * Démarre l'API d'analyse, ouvre l'interface, dépose un morceau, lance le show
 * puis vérifie que le spectacle dessine, que la lecture avance et que toutes
 * les commandes répondent. C'est le seul test qui voit ce que les tests
 * unitaires ne peuvent pas voir.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const API_PORT = 8791;
const API = `http://127.0.0.1:${API_PORT}`;

const { loadChromium } = await import("./playwright.mjs");
const chromium = await loadChromium();
const failures = [];

function buildTrack(workspace) {
  const file = join(workspace, "piste-test.wav");
  const result = spawnSync("uv", ["run", "python", "tests/make_fixture.py", file, "12.0"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0 || !existsSync(file)) throw new Error("impossible de générer la piste de test");
  return file;
}

function startApi(sessionDir) {
  return spawn(
    ".venv/bin/uvicorn",
    ["server.main:app", "--host", "127.0.0.1", "--port", String(API_PORT)],
    {
      cwd: root,
      stdio: process.env.CHECK_DEBUG ? "inherit" : "ignore",
      env: { ...process.env, SESSION_DIR: sessionDir, PORT: String(API_PORT) },
      detached: true,
    },
  );
}

async function waitForUrl(url, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // pas encore prêt
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${url} n'a pas démarré`);
}

const audioState = (page) =>
  page.evaluate(() => {
    const node = document.querySelector("audio");
    if (node === null) return { missing: true, paused: true, time: 0, duration: 0, volume: 0 };
    return {
      missing: false,
      paused: node.paused,
      time: node.currentTime,
      duration: node.duration,
      volume: node.volume,
    };
  });

const litPixels = (page) =>
  page.evaluate(() => {
    const node = document.querySelector("#stage");
    const data = node.getContext("2d").getImageData(0, 0, node.width, node.height).data;
    let lit = 0;
    let total = 0;
    let brightest = 0;
    for (let index = 0; index < data.length; index += 4 * 97) {
      total += 1;
      const sum = data[index] + data[index + 1] + data[index + 2];
      if (sum > 40) lit += 1;
      if (sum > brightest) brightest = sum;
    }
    return { lit, total, brightest, width: node.width, height: node.height };
  });

const workspace = mkdtempSync(join(tmpdir(), "night-light-check-"));
const api = startApi(join(workspace, "night-light-sessions"));
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });

try {
  await waitForUrl(`${API}/api/health`);
  await waitForUrl(`${API}/`);
  const track = buildTrack(workspace);

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(`${API}/`, { waitUntil: "domcontentloaded" });

  const dropTitle = await page.locator(".dropzone-title").innerText();
  if (!dropTitle.includes("Dépose ta musique ici")) failures.push(`texte de la zone inattendu : ${dropTitle}`);
  if (!(await page.locator("#dropzone").isVisible())) failures.push("zone de dépôt invisible");

  // ---- upload et analyse
  await page.setInputFiles("#file-input", track);
  await page.waitForSelector('body[data-analysis-ready="true"]', { timeout: 120000 });
  console.log("analyse prête : show lancé automatiquement");
  const analyzePanel = await page.locator("#screen-analysis .panel").isVisible().catch(() => false);
  if (analyzePanel) failures.push("le panneau d'analyse en bas est toujours visible");

  // Pas de lecteur externe dans ce bac à sable : raccourci forcé pour le show analysé.
  await page.keyboard.press("s");
  await page.waitForSelector("#screen-show.is-active", { timeout: 20000 });
  // On attend que la lecture avance vraiment : sous charge, le décodage du
  // fichier peut prendre plusieurs secondes, et un délai fixe produisait des
  // alertes sans rapport avec le code.
  const demarrage = Date.now() + 20000;
  let started = await audioState(page);
  while (Date.now() < demarrage && started.time < 0.3) {
    await page.waitForTimeout(250);
    started = await audioState(page);
  }

  if (started.missing) failures.push("élément audio introuvable");
  if (started.paused) failures.push("l'audio est en pause juste après le lancement");
  if (started.time < 0.3) failures.push(`l'audio n'avance pas (${started.time}s)`);

  const canvas = await litPixels(page);
  if (canvas.lit < canvas.total * 0.02) failures.push(`canvas quasi vide : ${JSON.stringify(canvas)}`);
  console.log(`canvas ${canvas.width}x${canvas.height} — ${canvas.lit}/${canvas.total} pixels allumés, max ${canvas.brightest}`);

  // ---- pause / reprise
  await page.click("#btn-play");
  await page.waitForTimeout(400);
  const paused = (await audioState(page)).time;
  await page.waitForTimeout(800);
  const stillPaused = (await audioState(page)).time;
  if (Math.abs(stillPaused - paused) > 0.05) {
    failures.push(`la pause ne fige pas la lecture (${paused} -> ${stillPaused})`);
  }
  await page.click("#btn-play");
  await page.waitForTimeout(900);
  const resumed = (await audioState(page)).time;
  if (resumed < paused + 0.2) failures.push(`la reprise n'avance pas (${paused} -> ${resumed})`);
  console.log(`pause/reprise OK (${paused.toFixed(2)}s -> ${resumed.toFixed(2)}s)`);

  // ---- confort visuel
  await page.check("#chk-reduced");
  await page.check("#chk-noflash");
  await page.waitForTimeout(1200);
  const reducedTime = (await audioState(page)).time;
  if (reducedTime < resumed) failures.push("la lecture s'est arrêtée en mode réduit");
  console.log(`mode réduit : ${(await litPixels(page)).lit} pixels allumés, lecture à ${reducedTime.toFixed(2)}s`);

  // ---- retour au début
  await page.click("#btn-restart");
  await page.waitForTimeout(700);
  const restarted = (await audioState(page)).time;
  if (restarted > 4) failures.push(`le redémarrage ne revient pas au début (${restarted.toFixed(2)}s)`);

  // ---- volume
  await page.locator("#volume").fill("30");
  const volume = (await audioState(page)).volume;
  if (Math.abs(volume - 0.3) > 0.01) failures.push(`volume non appliqué (${volume})`);

  // ---- retour à l'écran de dépôt
  await page.click("#btn-change-track");
  await page.waitForSelector("#screen-drop.is-active", { timeout: 8000 });
  if (!(await page.locator("#dropzone").isVisible())) failures.push("retour au dépôt impossible");

  if (consoleErrors.length > 0) failures.push(`erreurs console : ${consoleErrors.slice(0, 4).join(" | ")}`);

  await page.close();
} catch (error) {
  failures.push(`exception : ${error && error.stack ? error.stack : String(error)}`);
} finally {
  await browser.close().catch(() => {});
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
console.log("\nVérification navigateur : tout est vert.");
