/**
 * Repli : un morceau non reconnu ne doit pas produire d'écran d'erreur.
 * On doit repasser en direct, avec un petit avis en bas.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const API_PORT = 8834;
const API = `http://127.0.0.1:${API_PORT}`;
const FAKE_SOURCE = join(root, "tests", "fake_playerctl.py");
const { chromium } = await import("/home/mattia/node_modules/playwright");

const failures = [];
const workspace = mkdtempSync(join(tmpdir(), "night-light-repli-"));
// Le fichier analysé et le morceau joué ne portent pas du tout le même titre.
const track = join(workspace, "Autre Morceau.wav");
spawnSync("uv", ["run", "python", "tests/make_fixture.py", track, "60.0"], { cwd: root, encoding: "utf8" });

const binDir = join(workspace, "bin");
mkdirSync(binDir, { recursive: true });
const wrapper = join(binDir, "playerctl");
writeFileSync(wrapper, `#!/bin/sh\nexec python3 ${FAKE_SOURCE} "$@"\n`, { mode: 0o755 });
chmodSync(wrapper, 0o755);
const statePath = join(workspace, "player-state.json");
writeFileSync(statePath, JSON.stringify({ status: "Playing", title: "Titre Sans Rapport", artist: "Artiste", album: "", length_us: 200_000_000, position: 30.0, updated_at: Date.now() / 1000 }));

const api = spawn(".venv/bin/uvicorn", ["server.main:app", "--host", "127.0.0.1", "--port", String(API_PORT)], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, SESSION_DIR: join(workspace, "night-light-sessions"), PORT: String(API_PORT), PATH: `${binDir}:${process.env.PATH}`, FAKE_PLAYER_STATE: statePath },
  detached: true,
});

async function waitForApi(url, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("api non démarrée");
}

const text = (page, id) => page.$eval(`#${id}`, (n) => (n.textContent ?? "").trim());

let browser = null;

try {
  await waitForApi(`${API}/api/health`);
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext();
  const show = await context.newPage();
  show.setViewportSize({ width: 1280, height: 800 });
  const dash = await context.newPage();
  show.on("pageerror", (e) => failures.push(`show : ${String(e).slice(0, 160)}`));

  await show.goto(`${API}/`, { waitUntil: "domcontentloaded" });
  await dash.goto(`${API}/dashboard`, { waitUntil: "domcontentloaded" });
  await show.waitForFunction(() => typeof window.nightLight !== "undefined");

  await dash.setInputFiles("#file-input", track);
  console.log("analyse lancée, on attend le repli (20 s de tentatives)…");

  // Le repli arrive après les 10 tentatives de calage (20 s). Pendant ce temps
  // le show reste en direct : c'est l'avis qui marque le repli, pas le mode.
  const fin = Date.now() + 90000;
  let mode = "";
  let avisApparu = "";
  while (Date.now() < fin) {
    mode = await text(dash, "kpi-mode");
    avisApparu = await text(dash, "notice");
    if (avisApparu !== "") break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const ecranShow = await show.evaluate(() => document.querySelector(".screen.is-active")?.id ?? "aucun");
  const erreurVisible = await show.evaluate(() => {
    const node = document.getElementById("screen-error");
    if (node === null) return false;
    for (let current = node; current !== null; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return node.getBoundingClientRect().width > 1;
  });
  const avisDashboard = await text(dash, "notice");
  const avisShow = await show.evaluate(() => {
    const node = document.getElementById("notice");
    return node === null || node.hidden ? "" : (node.textContent ?? "").trim();
  });

  console.log(`mode : ${mode}`);
  console.log(`écran de show : ${ecranShow} · écran d'erreur visible : ${erreurVisible ? "OUI" : "non"}`);
  console.log(`avis dashboard : « ${avisDashboard} »`);
  console.log(`avis écran show : « ${avisShow} »`);

  if (mode !== "Live") failures.push(`pas de repli en direct (mode ${mode})`);
  if (erreurVisible) failures.push("un écran d'erreur s'affiche pour un morceau non reconnu");
  if (avisDashboard === "") failures.push("aucun avis discret sur le dashboard");
  if (!avisDashboard.includes("non reconnu")) failures.push(`avis inattendu : ${avisDashboard}`);
  if (avisShow === "") failures.push("aucun avis discret sur l'écran de show");

  await browser.close();
} catch (error) {
  failures.push(String(error));
  console.error("ERREUR", error);
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  try { process.kill(-api.pid, "SIGKILL"); } catch { api.kill("SIGKILL"); }
  spawnSync("pkill", ["-9", "-f", `--port ${API_PORT}`]);
}

if (failures.length > 0) {
  console.error("\nÉCHECS :");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("\nRepli sur le direct : tout est vert.");
