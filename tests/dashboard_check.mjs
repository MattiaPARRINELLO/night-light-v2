#!/usr/bin/env node
/**
 * Régression : deux morceaux à la suite depuis le dashboard.
 *
 *   bun tests/dashboard_check.mjs
 *
 * Le premier show fonctionnait, le deuxième restait bloqué sur l'ancien : la
 * garde `syncedMode` de `tryAutoSynced` valait encore `true` et faisait sortir
 * avant tout démarrage. On enchaîne donc deux analyses et on vérifie que
 * l'écran de show suit la deuxième : mode, position, et pixels qui bougent.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const API_PORT = 8818;
const API = `http://127.0.0.1:${API_PORT}`;
const FAKE_SOURCE = join(root, "tests", "fake_playerctl.py");

const playwrightPath = "/home/mattia/node_modules/playwright";
if (!existsSync(playwrightPath)) {
  console.error(`Playwright introuvable : ${playwrightPath}`);
  process.exit(2);
}
const { createRequire } = await import("node:module");
const { chromium } = createRequire(import.meta.url)(playwrightPath);

/** Assez long pour que le show ne soit pas figé par la fin de piste. */
const DUREE = 90;
const failures = [];
const workspace = mkdtempSync(join(tmpdir(), "night-light-deux-"));

function prepare(name) {
  const track = join(workspace, `${name}.wav`);
  const built = spawnSync("uv", ["run", "python", "tests/make_fixture.py", track, String(DUREE)], {
    cwd: root,
    encoding: "utf8",
  });
  if (built.status !== 0 || !existsSync(track)) throw new Error(`fixture absente : ${name}`);
  return track;
}

const binDir = join(workspace, "bin");
mkdirSync(binDir, { recursive: true });
const wrapper = join(binDir, "playerctl");
writeFileSync(wrapper, `#!/bin/sh\nexec python3 ${FAKE_SOURCE} "$@"\n`, { mode: 0o755 });
chmodSync(wrapper, 0o755);
const statePath = join(workspace, "player-state.json");
/** Le faux lecteur joue `name` à la position `position`. */
const play = (name, position) =>
  writeFileSync(
    statePath,
    JSON.stringify({
      status: "Playing",
      title: name,
      artist: "",
      album: "",
      length_us: DUREE * 1_000_000,
      position,
      updated_at: Date.now() / 1000,
    }),
  );

const premier = prepare("Premier Morceau");
const second = prepare("Second Morceau");

const api = spawn(".venv/bin/uvicorn", ["server.main:app", "--host", "127.0.0.1", "--port", String(API_PORT)], {
  cwd: root,
  stdio: "ignore",
  env: {
    ...process.env,
    SESSION_DIR: join(workspace, "night-light-sessions"),
    PORT: String(API_PORT),
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_PLAYER_STATE: statePath,
  },
  detached: true,
});

async function waitForApi(url, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // pas encore prêt
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("api non démarrée");
}

const text = (page, id) => page.$eval(`#${id}`, (node) => (node.textContent ?? "").trim());

/**
 * Empreinte du canvas : moyenne, pixels allumés, maximum et une somme de
 * contrôle. La moyenne seule ne suffit pas — sur une scène sombre elle varie à
 * peine alors que l'image change complètement.
 */
const pixels = (page) =>
  page.evaluate(() => {
    const node = document.querySelector("#stage");
    const data = node.getContext("2d").getImageData(0, 0, node.width, node.height).data;
    let sum = 0;
    let lit = 0;
    let max = 0;
    let empreinte = 0;
    let total = 0;
    for (let index = 0; index < data.length; index += 4 * 53) {
      const v = (data[index] + data[index + 1] + data[index + 2]) / 3;
      sum += v;
      total += 1;
      if (v > 40) lit += 1;
      if (v > max) max = v;
      empreinte = (empreinte + Math.round(v)) % 1_000_003;
    }
    return { moyenne: Math.round(sum / Math.max(total, 1)), lit, max, empreinte };
  });

/** Attend que le show affiche `titre` et que sa position réelle avance. */
async function attendShow(page, titre, show, timeout = 120000) {
  const end = Date.now() + timeout;
  let mode = "";
  let attendu = "";
  let positions = [];
  while (Date.now() < end) {
    mode = await text(page, "kpi-mode");
    attendu = await text(page, "sync-expected");
    if (mode === "Show calé" && attendu === titre) {
      const position = await show.evaluate(() => {
        const app = window.nightLight;
        return (app.syncedStartMs + (Date.now() - app.syncedStartedAtEpoch)) / 1000;
      });
      positions.push(position);
      // Deux positions différentes et croissantes : le show vit vraiment.
      const dernier = positions[positions.length - 1];
      const premierV = positions[0];
      if (positions.length >= 3 && dernier > premierV && dernier > 0) {
        return { mode, attendu, position: dernier, positions };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { mode, attendu, position: positions.at(-1) ?? -1, positions };
}

let browser = null;

try {
  await waitForApi(`${API}/api/health`);
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext();
  const show = await context.newPage();
  show.setViewportSize({ width: 1280, height: 800 });
  const dash = await context.newPage();
  dash.setViewportSize({ width: 1280, height: 900 });

  const erreurs = [];
  show.on("pageerror", (error) => erreurs.push(`show : ${String(error).slice(0, 200)}`));
  dash.on("pageerror", (error) => erreurs.push(`dash : ${String(error).slice(0, 200)}`));
  show.on("console", (message) => {
    if (message.type() === "error") erreurs.push(`show[console] ${message.text().slice(0, 240)}`);
  });

  await show.goto(`${API}/`, { waitUntil: "domcontentloaded" });
  await dash.goto(`${API}/dashboard`, { waitUntil: "domcontentloaded" });
  // L'application doit avoir fini de démarrer avant d'envoyer un raccourci.
  await show.waitForSelector("canvas#stage");
  await show.waitForFunction(() => typeof window.nightLight !== "undefined");

  // ---- premier morceau
  play("Premier Morceau", 65.0);
  await dash.setInputFiles("#file-input", premier);
  const un = await attendShow(dash, "Premier Morceau", show);
  console.log(`1er morceau : ${un.mode} · attendu=${un.attendu} · positions ${un.positions.map((p) => p.toFixed(1)).join(" → ")}`);
  if (un.mode !== "Show calé" || un.attendu !== "Premier Morceau") {
    failures.push(`1er morceau non calé (${un.mode} / ${un.attendu})`);
  }
  if (un.position < 4) failures.push(`1er morceau : position inattendue (${un.position} s)`);
  const pixelsUn = await pixels(show);

  // ---- deuxième morceau, pendant que le premier show tourne
  play("Second Morceau", 67.0);
  await dash.setInputFiles("#file-input", second);
  const deux = await attendShow(dash, "Second Morceau", show);
  console.log(`2e morceau  : ${deux.mode} · attendu=${deux.attendu} · positions ${deux.positions.map((p) => p.toFixed(1)).join(" → ")}`);
  if (deux.mode !== "Show calé" || deux.attendu !== "Second Morceau") {
    failures.push(`2e morceau non calé (${deux.mode} / ${deux.attendu})`);
  }
  if (deux.position < 60) failures.push(`le show n'a pas suivi le 2e morceau (${deux.position} s)`);

  // ---- le show doit continuer à dessiner une image qui change
  const avant = await pixels(show);
  await show.waitForTimeout(1200);
  const apres = await pixels(show);
  console.log(`pixels : ${pixelsUn.lit} allumés → ${avant.lit} → ${apres.lit} · empreintes ${avant.empreinte} → ${apres.empreinte}`);
  if (avant.empreinte === apres.empreinte) failures.push("le canvas ne dessine plus après le 2e morceau");
  if (apres.lit < 50) failures.push(`canvas quasi vide après le 2e morceau (${apres.lit} pixels allumés)`);

  // ---- la capture doit continuer à vivre pendant le show, sinon le panneau
  // « Audio en direct » du dashboard reste figé sur les dernières valeurs.
  // Le visualiseur en barres, lui, doit rester masqué : il se superposerait
  // au spectacle.
  const capture = await show.evaluate(() => {
    const app = window.nightLight;
    const visuel = document.querySelector("#live-stage");
    return {
      ouverte: app.liveCapture !== null,
      messages: app.debugCapture.messages,
      visuelMasque:
        visuel === null || visuel.hasAttribute("hidden") || getComputedStyle(visuel).display === "none",
    };
  });
  console.log(
    `capture pendant le show : ${capture.ouverte ? "ouverte" : "FERMÉE"} · ${capture.messages} messages · ` +
      `visualiseur ${capture.visuelMasque ? "masqué" : "VISIBLE"}`,
  );
  if (!capture.ouverte) failures.push("la capture est coupée pendant le show (panneau audio figé)");
  if (!capture.visuelMasque) failures.push("le visualiseur en barres reste affiché par-dessus le show");
  if ((await text(dash, "audio-rate")) === "capture fermée") {
    failures.push("le dashboard annonce la capture fermée pendant le show");
  }

  for (const erreur of erreurs) failures.push(erreur);
  await browser.close();
} catch (error) {
  failures.push(`exception : ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  try {
    process.kill(-api.pid, "SIGKILL");
  } catch {
    api.kill("SIGKILL");
  }
  spawnSync("pkill", ["-9", "-f", `--port ${API_PORT}`]);
}

if (failures.length > 0) {
  console.error("\nÉCHECS :");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("\nDeux morceaux à la suite : tout est vert.");
