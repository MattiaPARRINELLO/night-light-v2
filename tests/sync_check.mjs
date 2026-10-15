#!/usr/bin/env node
/**
 * Vérification de la synchronisation Show ↔ lecteur externe, sans lecteur réel.
 *
 *   bun tests/sync_check.mjs
 *
 * Un faux `playerctl` (tests/fake_playerctl.py) joue un morceau de 12 s dont on
 * pilote la position et le titre. On dépose un fichier du même nom, puis on
 * vérifie que le show démarre à la bonne position, qu'il suit un saut de
 * lecture, et qu'un changement de morceau ramène en Live.
 *
 * C'est le test de non-régression du bug d'horloge : la position du lecteur
 * était mélangée avec `performance.now()` et ramenait le show à 0 en boucle.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const API_PORT = 8797;
const API = `http://127.0.0.1:${API_PORT}`;
const TITLE = "Neon Skyline";
const FAKE_SOURCE = join(root, "tests", "fake_playerctl.py");

const playwrightPath = "/home/mattia/node_modules/playwright";
if (!existsSync(playwrightPath)) {
  console.error(`Playwright introuvable : ${playwrightPath}`);
  process.exit(2);
}
const { createRequire } = await import("node:module");
const requireFromHere = createRequire(import.meta.url);
const { chromium } = requireFromHere(playwrightPath);

const failures = [];

function buildFakePlayer(binDir, statePath) {
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, "playerctl");
  writeFileSync(wrapper, `#!/bin/sh\nexec python3 ${FAKE_SOURCE} "$@"\n`, { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  return {
    path: `${binDir}:${process.env.PATH ?? ""}`,
    state: (state) => {
      writeFileSync(statePath, JSON.stringify({ ...state, updated_at: Date.now() / 1000 }));
    },
  };
}

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

const overlayLine = (text, prefix) => {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return null;
  const lecteur = Number(/([\d.]+) s/.exec(line)?.[1] ?? NaN);
  const show = Number(/show=([\d.]+) s/.exec(line)?.[1] ?? NaN);
  const ecart = Number(/écart=(-?[\d.]+) ms/.exec(line)?.[1] ?? NaN);
  return { raw: line, lecteur, show, ecart };
};

const overlayMode = (text) =>
  text
    .split("\n")
    .find((line) => line.startsWith("mode"))
    ?.replace(/\s+/g, " ")
    .trim() ?? "";

const workspace = mkdtempSync(join(tmpdir(), "night-light-sync-"));
const track = join(workspace, `${TITLE}.wav`);
const fixture = spawnSync("uv", ["run", "python", "tests/make_fixture.py", track, "12.0"], {
  cwd: root,
  encoding: "utf8",
});
if (fixture.status !== 0 || !existsSync(track)) throw new Error("impossible de générer la piste de test");

const fake = buildFakePlayer(join(workspace, "bin"), join(workspace, "player-state.json"));
// Artiste vide : évite la résolution automatique Deezer au démarrage du test.
fake.state({ status: "Playing", title: TITLE, artist: "", album: "", length_us: 12_000_000, position: 4.0 });

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
      PATH: fake.path,
      FAKE_PLAYER_STATE: join(workspace, "player-state.json"),
    },
    detached: true,
  },
);

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });

const readOverlay = async (page) => {
  const text = await page.$eval("#debug-overlay", (node) => node.textContent ?? "");
  return { text, mode: overlayMode(text), sync: overlayLine(text, "sync position") };
};

const waitForState = async (name, predicate, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  failures.push(`${name} : délai dépassé (${timeout / 1000} s)`);
  return false;
};

try {
  await waitForApi(`${API}/api/health`);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (error) => failures.push(`erreur de page : ${String(error)}`));
  await page.goto(`${API}/`, { waitUntil: "domcontentloaded" });

  // ---- analyse du morceau, puis démarrage automatique du show
  await page.setInputFiles("#file-input", track);
  if (!(await waitForState("analyse", async () => (await page.evaluate(() => document.body.dataset.analysisReady)) === "true", 120000))) {
    throw new Error("analyse interrompue");
  }
  await page.keyboard.press("d");

  const started = await waitForState("démarrage synchronisé", async () => {
    const { text } = await readOverlay(page);
    return text.includes("SHOW_SYNCED");
  });
  if (!started) throw new Error("show non synchronisé");

  const debut = await readOverlay(page);
  console.log(`démarrage : ${debut.sync?.raw ?? debut.mode}`);
  if (debut.sync !== null && Math.abs(debut.sync.ecart) > 400) {
    failures.push(`écart initial trop grand : ${debut.sync.ecart} ms`);
  }
  // Le faux lecteur continue de jouer pendant l'analyse : seule compte la
  // concordance entre la position lancée et celle du lecteur à cet instant.
  if (debut.sync !== null && Math.abs(debut.sync.show - debut.sync.lecteur) > 0.4) {
    failures.push(
      `position de départ désalignée : show ${debut.sync.show} s vs lecteur ${debut.sync.lecteur} s`,
    );
  }
  if (debut.sync !== null && debut.sync.show < 3) {
    failures.push(`position de départ trop basse : ${debut.sync.show} s`);
  }

  /**
   * Saute le lecteur de `delta` secondes et vérifie que le show rejoint la
   * nouvelle position. Le resync ne tournant que toutes les 2,5 s, le show ne
   * peut jamais viser la cible exacte : on exige un mouvement net dans le bon
   * sens, puis un écart faible une fois recadré.
   */
  const saut = async (label, delta) => {
    const avant = await readOverlay(page);
    const base = avant.sync?.show ?? 0;
    const lecteurActuel = avant.sync?.lecteur ?? 0;
    const cible = Math.max(0.5, lecteurActuel + delta);
    fake.state({ status: "Playing", title: TITLE, artist: "", album: "", length_us: 12_000_000, position: cible });
    const echantillons = [];
    const ok = await waitForState(
      `saut ${label}`,
      async () => {
        const { sync } = await readOverlay(page);
        if (sync !== null) echantillons.push(sync);
        // La resynchronisation ne passe que toutes les 2,5 s et la requête de
        // position ajoute son délai : le show arrive donc jusqu'à ~3 s après la
        // nouvelle position. On exige un mouvement franc, pas la position exacte.
        return (
          sync !== null &&
          Math.abs(sync.ecart) <= 300 &&
          (delta < 0 ? sync.show <= base - 1.5 : sync.show >= base + 1.5)
        );
      },
      20000,
    );
    const valeurs = echantillons.map((sample) => sample.show);
    const dernier = echantillons.at(-1)?.show ?? base;
    console.log(
      `${label} : lecteur ${lecteurActuel.toFixed(2)} s → ${cible.toFixed(2)} s · ` +
        `show passé de ${base.toFixed(2)} s à ${dernier.toFixed(2)} s · ` +
        (echantillons.at(-1)?.raw ?? "?"),
    );
    const ecartFinal = echantillons.at(-1)?.ecart ?? Number.NaN;
    if (!ok) failures.push(`saut ${label} : le show n'a pas suivi (${echantillons.at(-1)?.raw ?? "?"})`);
    if (!Number.isNaN(ecartFinal) && Math.abs(ecartFinal) > 300) {
      failures.push(`saut ${label} : écart résiduel ${Math.round(ecartFinal)} ms`);
    }
    return dernier;
  };

  // ---- recul puis avance dans le morceau
  const basApresRecul = await saut("recul de 5 s", -5);
  const hautApresAvance = await saut("avance de 5 s", 5);
  if (hautApresAvance <= basApresRecul) {
    failures.push(`la trajectoire n'a pas remonté (${basApresRecul.toFixed(2)} s → ${hautApresAvance.toFixed(2)} s)`);
  }

  // ---- dérive lente du lecteur : le show doit se recaler en douceur
  // On fait avancer l'horloge du faux lecteur 4 % plus vite que le temps réel :
  // l'écart grandit donc de ~40 ms par seconde et franchit le seuil de 150 ms.
  // Avant la correction progressive, ce recalage déplaçait le temps du show d'un
  // coup, et tous les mouvements calés sur le tempo sautaient (les wash surtout).
  const derive = await readOverlay(page);
  const baseDerive = derive.sync?.show ?? 0;
  fake.state({
    status: "Playing",
    title: TITLE,
    artist: "",
    album: "",
    length_us: 200_000_000,
    position: Math.max(baseDerive, 1),
    rate: 1.04,
  });
  // On lit le temps réellement utilisé par le rendu, pas l'overlay : celui-ci
  // n'est rafraîchi que toutes les 500 ms, et sa granularité se confondrait
  // avec un saut.
  const mesures = [];
  for (let i = 0; i < 120; i += 1) {
    const mesure = await page.evaluate(() => ({
      t: window.nightLight.showTimeMs(Date.now()),
      ecart: Math.abs(window.nightLight.debugSync?.driftMs ?? 0),
    }));
    mesures.push({ ...mesure, mur: Date.now() });
    await page.waitForTimeout(80);
  }

  // Ce qu'on juge est la vitesse du show entre deux mesures, pas la différence
  // brute : l'intervalle réel varie (aller-retour Playwright), alors qu'un saut
  // de temps se voit comme une vitesse aberrante. Un rattrapage progressif
  // demande au show de courir au plus 1,5 fois plus vite.
  let pireVitesse = 0;
  let plusLente = Number.POSITIVE_INFINITY;
  let pireEcart = 0;
  for (let i = 0; i < mesures.length; i += 1) {
    pireEcart = Math.max(pireEcart, mesures[i].ecart);
    if (i === 0) continue;
    const dt = mesures[i].t - mesures[i - 1].t;
    const mur = mesures[i].mur - mesures[i - 1].mur;
    if (mur < 20) continue;
    const vitesse = dt / mur;
    pireVitesse = Math.max(pireVitesse, vitesse);
    plusLente = Math.min(plusLente, vitesse);
  }
  console.log(
    `dérive du lecteur : pire écart ${Math.round(pireEcart)} ms · vitesse du show de ` +
      `${plusLente.toFixed(2)}× à ${pireVitesse.toFixed(2)}×`,
  );
  if (pireEcart > 700) failures.push(`l'écart n'est pas rattrapé (${Math.round(pireEcart)} ms)`);
  if (pireVitesse > 2) failures.push(`le temps du show saute (${pireVitesse.toFixed(2)}× la vitesse réelle)`);
  if (plusLente < 0.4) failures.push(`le temps du show se fige (${plusLente.toFixed(2)}×)`);

  // ---- changement de morceau : retour en Live
  fake.state({ status: "Playing", title: "Tout autre morceau", artist: "", album: "", length_us: 11_000_000, position: 1.0 });
  const retourLive = await waitForState("retour en Live", async () => (await readOverlay(page)).text.includes("mode            LIVE"));
  console.log(`changement de morceau : ${retourLive ? "retour en Live OK" : "PAS de retour en Live"}`);

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
console.log("\nSynchronisation : tout est vert.");
