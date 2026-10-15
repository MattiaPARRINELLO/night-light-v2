/**
 * Un changement de scène ne doit pas faire passer l'écran par le noir : les
 * deux scènes se croisent, et le fond commun reste visible tout du long.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const API_PORT = 8836;
const API = `http://127.0.0.1:${API_PORT}`;
const FAKE_SOURCE = join(root, "tests", "fake_playerctl.py");
const { chromium } = await import("/home/mattia/node_modules/playwright");

const workspace = mkdtempSync(join(tmpdir(), "night-light-fondu-"));
// Piste « riche » : le troisième quart (30-45 s) est intense et homogène, donc
// aucune baisse de luminosité n'y est musicalement justifiée.
const track = join(workspace, "Riche.wav");
spawnSync("uv", ["run", "python", "tests/make_fixture.py", track, "rich"], { cwd: root, encoding: "utf8" });

const binDir = join(workspace, "bin");
mkdirSync(binDir, { recursive: true });
const wrapper = join(binDir, "playerctl");
writeFileSync(wrapper, `#!/bin/sh\nexec python3 ${FAKE_SOURCE} "$@"\n`, { mode: 0o755 });
chmodSync(wrapper, 0o755);
const statePath = join(workspace, "player-state.json");
writeFileSync(statePath, JSON.stringify({ status: "Playing", title: "Riche", artist: "", album: "", length_us: 60_000_000, position: 30.0, updated_at: Date.now() / 1000 }));

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

const luminance = (page) =>
  page.evaluate(() => {
    const node = document.querySelector("#stage");
    const data = node.getContext("2d").getImageData(0, 0, node.width, node.height).data;
    let sum = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4 * 53) {
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      total += 1;
    }
    return sum / Math.max(total, 1);
  });

let browser = null;

try {
  await waitForApi(`${API}/api/health`);
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext();
  const show = await context.newPage();
  show.setViewportSize({ width: 1280, height: 800 });
  const dash = await context.newPage();
  await show.goto(`${API}/`, { waitUntil: "domcontentloaded" });
  await dash.goto(`${API}/dashboard`, { waitUntil: "domcontentloaded" });
  await show.waitForFunction(() => typeof window.nightLight !== "undefined");

  await dash.setInputFiles("#file-input", track);
  const fin = Date.now() + 120000;
  while (Date.now() < fin && (await dash.$eval("#kpi-mode", (n) => n.textContent)) !== "Show calé") {
    await new Promise((r) => setTimeout(r, 400));
  }

  // Bornes de scènes sur la plage survolée, pour savoir où sont les frontières.
  const bornes = await show.evaluate(() => {
    const plan = window.nightLight.syncedPlan;
    return plan.scenes.map((s) => ({ start: Number(s.start.toFixed(2)), end: Number(s.end.toFixed(2)), family: s.family }));
  });

  const mesures = [];
  for (let i = 0; i < 120; i += 1) {
    const t = await show.evaluate(() => (window.nightLight.syncedStartMs + (Date.now() - window.nightLight.syncedStartedAtEpoch)) / 1000);
    mesures.push({ t, v: await luminance(show) });
    await show.waitForTimeout(100);
  }

  const valeurs = mesures.map((m) => m.v).sort((a, b) => a - b);
  const min = valeurs[0];
  const max = valeurs[valeurs.length - 1];
  const mediane = valeurs[Math.floor(valeurs.length / 2)];
  console.log(`plage survolée : ${mesures[0].t.toFixed(1)} s → ${mesures[mesures.length - 1].t.toFixed(1)} s`);
  console.log(`scènes : ${bornes.map((b) => `${b.family} ${b.start}-${b.end}`).join(" · ")}`);
  console.log(`luminosité : min ${min.toFixed(0)} · médiane ${mediane.toFixed(0)} · max ${max.toFixed(0)}`);
  console.log(`plancher : le minimum vaut ${((min / mediane) * 100).toFixed(0)} % de la médiane`);

  // Profil autour d'un changement de scène de la plage, pour garder une trace
  // lisible de la forme du croisement.
  const frontiere = bornes.find((b) => b.end > mesures[0].t + 2 && b.end < mesures[mesures.length - 1].t - 2);
  if (frontiere !== undefined) {
    console.log(`\nprofil autour de ${frontiere.end.toFixed(1)} s (${frontiere.family}) :`);
    for (const m of mesures) {
      if (m.t < frontiere.end - 1.5 || m.t > frontiere.end + 1.5) continue;
      const barre = "█".repeat(Math.round((m.v / max) * 40));
      console.log(`  t=${m.t.toFixed(1)}s ${String(Math.round(m.v)).padStart(3)} ${barre}`);
    }
  }

  // Un creux à une frontière compare deux scènes de luminosité différente, ce
  // qui est voulu : ce qu'on vérifie est le plancher global — les couches
  // permanentes garantissent qu'il reste toujours de la lumière.
  if (min / Math.max(mediane, 1) < 0.35) {
    console.error(`l'écran plonge trop bas : ${((min / mediane) * 100).toFixed(0)} % de la médiane`);
    process.exitCode = 1;
  } else {
    console.log("\nl'écran ne passe jamais par le noir.");
  }

  await browser.close();
} catch (error) {
  console.error("ERREUR", error);
  process.exitCode = 1;
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  try { process.kill(-api.pid, "SIGKILL"); } catch { api.kill("SIGKILL"); }
  spawnSync("pkill", ["-9", "-f", `--port ${API_PORT}`]);
}
