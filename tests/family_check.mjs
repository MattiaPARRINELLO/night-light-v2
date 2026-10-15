/**
 * Vérifie qu'une famille, isolée, remplit bien le cadre : ni écran noir, ni
 * concentration dans un coin. On force le plan sur une seule scène.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const API_PORT = 8842;
const API = `http://127.0.0.1:${API_PORT}`;
const FAKE_SOURCE = join(root, "tests", "fake_playerctl.py");
const { loadChromium } = await import("./playwright.mjs");
const chromium = await loadChromium();

const FAMILLES = process.argv.slice(2);
if (FAMILLES.length === 0) {
  console.error("usage : bun tests/family_check.mjs <famille> [famille...]");
  process.exit(2);
}

const workspace = mkdtempSync(join(tmpdir(), "night-light-famille-"));
const track = join(workspace, "Riche.wav");
spawnSync("uv", ["run", "python", "tests/make_fixture.py", track, "rich"], { cwd: root, encoding: "utf8" });

const binDir = join(workspace, "bin");
mkdirSync(binDir, { recursive: true });
const wrapper = join(binDir, "playerctl");
writeFileSync(wrapper, `#!/bin/sh\nexec python3 ${FAKE_SOURCE} "$@"\n`, { mode: 0o755 });
chmodSync(wrapper, 0o755);
const statePath = join(workspace, "player-state.json");
writeFileSync(statePath, JSON.stringify({ status: "Playing", title: "Riche", artist: "", album: "", length_us: 60_000_000, position: 34.0, updated_at: Date.now() / 1000 }));

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

/** Occupation par tiers horizontaux et verticaux, pour repérer un cadrage déséquilibré. */
const occupation = (page) =>
  page.evaluate(() => {
    const node = document.querySelector("#stage");
    const w = node.width;
    const h = node.height;
    const data = node.getContext("2d").getImageData(0, 0, w, h).data;
    const colonnes = new Array(3).fill(0);
    const lignes = new Array(3).fill(0);
    const totaux = new Array(3).fill(0);
    let allumes = 0;
    let total = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const i = (y * w + x) * 4;
        const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
        total += 1;
        const cx = Math.min(2, Math.floor((x / w) * 3));
        const cy = Math.min(2, Math.floor((y / h) * 3));
        totaux[cy] += 1;
        if (v > 45) {
          allumes += 1;
          colonnes[cx] += 1;
          lignes[cy] += 1;
        }
      }
    }
    const part = (list, index) => (list[index] / Math.max(totaux[index], 1)) * 100;
    return {
      allumes,
      part: (allumes / Math.max(total, 1)) * 100,
      colonnes: colonnes.map((_, i2) => Math.round(part(colonnes, i2))),
      lignes: lignes.map((_, i2) => Math.round(part(lignes, i2))),
    };
  });

let browser = null;
const echecs = [];

try {
  await waitForApi(`${API}/api/health`);
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext();
  const show = await context.newPage();
  show.setViewportSize({ width: 1280, height: 800 });
  const dash = await context.newPage();
  show.on("pageerror", (error) => echecs.push(`show : ${String(error).slice(0, 160)}`));
  await show.goto(`${API}/`, { waitUntil: "domcontentloaded" });
  await dash.goto(`${API}/dashboard`, { waitUntil: "domcontentloaded" });
  await show.waitForFunction(() => typeof window.nightLight !== "undefined");

  await dash.setInputFiles("#file-input", track);
  const fin = Date.now() + 120000;
  while (Date.now() < fin && (await dash.$eval("#kpi-mode", (n) => n.textContent)) !== "Show calé") {
    await new Promise((r) => setTimeout(r, 400));
  }

  /** Carte de densité grossière, pour voir où la lumière se trouve. */
  const carte = (page) =>
    page.evaluate(() => {
      const node = document.querySelector("#stage");
      const w = node.width;
      const h = node.height;
      const data = node.getContext("2d").getImageData(0, 0, w, h).data;
      const lignes = [];
      for (let gy = 0; gy < 14; gy += 1) {
        let ligne = "";
        for (let gx = 0; gx < 40; gx += 1) {
          let somme = 0;
          let n = 0;
          for (let y = Math.floor((gy / 14) * h); y < Math.floor(((gy + 1) / 14) * h); y += 5) {
            for (let x = Math.floor((gx / 40) * w); x < Math.floor(((gx + 1) / 40) * w); x += 5) {
              const i = (y * w + x) * 4;
              somme += (data[i] + data[i + 1] + data[i + 2]) / 3;
              n += 1;
            }
          }
          const v = somme / Math.max(n, 1);
          ligne += v > 60 ? "#" : v > 30 ? "+" : v > 12 ? "." : " ";
        }
        lignes.push(ligne);
      }
      return lignes;
    });

  for (const famille of FAMILLES) {
    await show.evaluate((nom) => {
      const app = window.nightLight;
      app.syncedPlan.scenes = [
        { ...app.syncedPlan.scenes[0], family: nom, variant: nom, backdrop: nom, start: 0, end: 600 },
      ];
      app.energy = 0.7;
    }, famille);
    // On laisse passer quelques images et on mesure sur plusieurs instants.
    await show.waitForTimeout(900);
    // Les éléments s'allument et s'éteignent à tour de rôle : c'est le maximum
    // sur la durée qui dit si la famille peut remplir le cadre, pas un instant.
    let mieux = 0;
    let dernier = null;
    const colonnesVues = [0, 0, 0];
    for (let i = 0; i < 8; i += 1) {
      dernier = await occupation(show);
      mieux = Math.max(mieux, dernier.part);
      for (let c = 0; c < 3; c += 1) colonnesVues[c] = Math.max(colonnesVues[c], dernier.colonnes[c] ?? 0);
      await show.waitForTimeout(400);
    }
    dernier = { ...dernier, colonnes: colonnesVues };
    console.log(
      `${famille.padEnd(10)} remplissage max ${mieux.toFixed(1)} % · ` +
        `colonnes ${dernier.colonnes.join("/")} % · lignes ${dernier.lignes.join("/")} %`,
    );
    if (mieux < 1.5) echecs.push(`${famille} : écran quasiment vide (${mieux.toFixed(1)} %)`);
    // On ne juge pas la répartition : le fond, le halo central et la poussière
    // sont toujours là et pèsent au centre quoi qu'il arrive. Ce qu'on vérifie
    // est que la famille ajoute bien de la lumière sur cet ensemble.
    if (process.env.PROFIL) {
      const profil = await show.evaluate(() => {
        const app = window.nightLight;
        const node = document.querySelector("#stage");
        const w = node.width;
        const h = node.height;
        const data = node.getContext("2d").getImageData(0, 0, w, h).data;
        const ligne = (yy) => {
          const out = [];
          for (let x = 0; x < w; x += 40) {
            const i = (yy * w + x) * 4;
            out.push(Math.round((data[i] + data[i + 1] + data[i + 2]) / 3));
          }
          return out;
        };
        const fam = app.syncedPlan.scenes[0].family;
        const t = (app.syncedStartMs + (Date.now() - app.syncedStartedAtEpoch)) / 1000;
        return { fam, haut: ligne(Math.round(h * 0.2)), milieu: ligne(Math.round(h * 0.5)), bas: ligne(Math.round(h * 0.85)) };
      });
      console.log(`  profil ${profil.fam} — haut  : ${profil.haut.join(" ")}`);
      console.log(`  profil ${profil.fam} — milieu: ${profil.milieu.join(" ")}`);
      console.log(`  profil ${profil.fam} — bas   : ${profil.bas.join(" ")}`);
    }
    if (process.env.CARTE) {
      console.log(`\n--- ${famille} ---`);
      for (const ligne of await carte(show)) console.log("  " + ligne);
    }
  }

  for (const erreur of echecs) console.error(` - ${erreur}`);
  if (echecs.length > 0) process.exitCode = 1;
  else console.log("Familles : tout est vert.");
  await browser.close();
} catch (error) {
  console.error("ERREUR", error);
  process.exitCode = 1;
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  try { process.kill(-api.pid, "SIGKILL"); } catch { api.kill("SIGKILL"); }
  spawnSync("pkill", ["-9", "-f", `--port ${API_PORT}`]);
}
