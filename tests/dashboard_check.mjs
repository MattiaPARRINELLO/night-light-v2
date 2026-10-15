#!/usr/bin/env node
/**
 * Vérification du tableau de bord : deux pages, deux rôles.
 *
 *   bun tests/dashboard_check.mjs
 *
 * L'écran de show (`/`) et le dashboard (`/dashboard`) se parlent par
 * BroadcastChannel. On vérifie que le lien monte, que l'écran de show passe en
 * kiosk (plus aucune interface), que le dashboard pilote l'overlay de debug et
 * la latence, et qu'une analyse lancée depuis le dashboard finit par caler le
 * show sur le faux lecteur.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const API_PORT = 8803;
const API = `http://127.0.0.1:${API_PORT}`;
const TITLE = "Neon Skyline";
const FAKE_SOURCE = join(root, "tests", "fake_playerctl.py");

const playwrightPath = "/home/mattia/node_modules/playwright";
if (!existsSync(playwrightPath)) {
  console.error(`Playwright introuvable : ${playwrightPath}`);
  process.exit(2);
}
const { createRequire } = await import("node:module");
const { chromium } = requireFromHere();
function requireFromHere() {
  return require("/home/mattia/node_modules/playwright");
}

const failures = [];

const workspace = mkdtempSync(join(tmpdir(), "night-light-dash-"));
const track = join(workspace, `${TITLE}.wav`);
const fixture = spawnSync("uv", ["run", "python", "tests/make_fixture.py", track, "12.0"], { cwd: root, encoding: "utf8" });
if (fixture.status !== 0 || !existsSync(track)) throw new Error("fixture absente");

// Faux lecteur : le morceau analysé doit correspondre au morceau joué.
const binDir = join(workspace, "bin");
mkdirSync(binDir, { recursive: true });
const wrapper = join(binDir, "playerctl");
writeFileSync(wrapper, `#!/bin/sh\nexec python3 ${FAKE_SOURCE} "$@"\n`, { mode: 0o755 });
chmodSync(wrapper, 0o755);
const statePath = join(workspace, "player-state.json");
writeFileSync(
  statePath,
  JSON.stringify({ status: "Playing", title: TITLE, artist: "", album: "", length_us: 12_000_000, position: 4.0, updated_at: Date.now() / 1000 }),
);

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

let browser = null;

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

try {
  await waitForApi(`${API}/api/health`);

  const response = await fetch(`${API}/dashboard`);
  if (response.status !== 200) failures.push(`/dashboard renvoie ${response.status}`);
  const dashHtml = await response.text();
  if (!dashHtml.includes("Contrôle du spectacle")) failures.push("/dashboard n'a pas le bon contenu");
  console.log(`/dashboard → ${response.status} (${dashHtml.length} octets)`);

  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  // Un seul contexte : deux pages du même contexte partagent le BroadcastChannel,
  // exactement comme deux onglets du même navigateur.
  const context = await browser.newContext();
  const show = await context.newPage();
  show.setViewportSize({ width: 1280, height: 800 });
  const dashPage = await context.newPage();
  dashPage.setViewportSize({ width: 1280, height: 900 });
  show.on("pageerror", (error) => failures.push(`erreur écran show : ${String(error)}`));
  dashPage.on("pageerror", (error) => failures.push(`erreur dashboard : ${String(error)}`));

  await show.goto(`${API}/`, { waitUntil: "domcontentloaded" });
  await dashPage.goto(`${API}/dashboard`, { waitUntil: "domcontentloaded" });

  // 1. le dashboard voit l'écran de show
  const deadline = Date.now() + 15000;
  let connected = false;
  while (Date.now() < deadline) {
    if ((await text(dashPage, "link-pill")) === "Show connecté") {
      connected = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.log(`lien show ↔ dashboard : ${connected ? "connecté" : "HORS LIGNE"}`);
  if (!connected) failures.push("le dashboard ne voit pas l'écran de show");

  // 2. l'écran de show passe en kiosk : plus aucune interface
  await dashPage.waitForTimeout(600);
  const kiosk = await show.evaluate(() => document.body.classList.contains("kiosk"));
  const hudVisible = await show.evaluate(() => {
    const node = document.getElementById("hud");
    return node !== null && getComputedStyle(node).display !== "none";
  });
  const dropVisible = await show.evaluate(() => {
    const node = document.getElementById("dock-panel");
    if (node === null) return false;
    // Un ancêtre en display:none rend l'élément effectivement invisible : c'est
    // ce que Playwright teste avec isVisible(), pas le display calculé.
    for (let current = node; current !== null; current = current.parentElement) {
      if (getComputedStyle(current).display === "none") return false;
    }
    return true;
  });
  console.log(`kiosk=${kiosk} · HUD=${hudVisible ? "visible" : "masqué"} · dock=${dropVisible ? "visible" : "masqué"}`);
  if (!kiosk) failures.push("l'écran de show n'est pas passé en kiosk");
  if (hudVisible) failures.push("le HUD reste visible en kiosk");
  if (dropVisible) failures.push("le dock reste visible en kiosk");
  const canvas = await show.evaluate(() => {
    const node = document.getElementById("stage");
    return { w: node.clientWidth, h: node.clientHeight };
  });
  console.log(`canvas : ${canvas.w}×${canvas.h}`);
  if (canvas.w < 1200 || canvas.h < 700) failures.push(`canvas trop petit en kiosk : ${JSON.stringify(canvas)}`);

  // 3. le dashboard pilote l'overlay de debug de l'écran de show
  await dashPage.click("#btn-debug");
  await dashPage.waitForTimeout(500);
  const overlayShown = await show.evaluate(() => {
    const node = document.getElementById("debug-overlay");
    return node !== null && !node.hasAttribute("hidden");
  });
  console.log(`overlay de debug piloté à distance : ${overlayShown ? "oui" : "non"}`);
  if (!overlayShown) failures.push("le dashboard ne pilote pas l'overlay de debug");

  // 4. analyse lancée depuis le dashboard → le show se cale
  await dashPage.setInputFiles("#file-input", track);
  const calageDeadline = Date.now() + 120000;
  let mode = "";
  while (Date.now() < calageDeadline) {
    mode = await text(dashPage, "kpi-mode");
    if (mode === "Show calé") break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const ecart = await text(dashPage, "kpi-drift");
  console.log(`mode après analyse : ${mode} · écart ${ecart}`);
  if (mode !== "Show calé") failures.push(`le show ne s'est pas calé (mode affiché : ${mode})`);
  if (!/^\+\d+ ms$|^-\d+ ms$|^0 ms$/.test(ecart)) failures.push(`écart illisible : ${ecart}`);

  // 5. la latence se règle à distance
  await dashPage.fill("#latency", "200");
  await dashPage.press("#latency", "Enter");
  await dashPage.waitForTimeout(700);
  const note = await text(dashPage, "kpi-drift-note");
  console.log(`latence affichée : ${note}`);
  if (!note.includes("200")) failures.push(`latence non transmise (${note})`);

  // 6. retour en Live à distance
  await dashPage.click("#btn-force-live");
  await dashPage.waitForTimeout(1500);
  const modeFinal = await text(dashPage, "kpi-mode");
  console.log(`mode après « Revenir en Live » : ${modeFinal}`);
  if (modeFinal !== "Live") failures.push("le retour en Live ne fonctionne pas");
  const kioskFinal = await show.evaluate(() => document.body.classList.contains("kiosk"));
  if (!kioskFinal) failures.push("l'écran de show a quitté le kiosk après retour en Live");

  await browser.close();
} catch (error) {
  failures.push(`exception : ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  // Le processus est détaché : on tue le groupe entier, sinon le python
  // d'uvicorn survit et garde le port pour la fois suivante.
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
console.log("\nDashboard : tout est vert.");
