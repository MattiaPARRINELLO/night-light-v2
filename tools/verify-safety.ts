/**
 * Vérification de sécurité photosensible (R3.1/R3.2).
 *
 * Sur les 10 pistes du corpus synthétique et les 4 titres de référence rap :
 * - fenêtres glissantes de 1 s contenant plus de 3 flashs ;
 * - flashs de temps fort dans les 1,5 s qui suivent un impact ;
 * - part de blanc plein écran en mode réduit à +0,1 s des drops.
 *
 * Le script sort en erreur si l'un des budgets est dépassé.
 *
 *     bun tools/verify-safety.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { flashAdmitted } from "../src/core/render";
import { createTrackView } from "../src/core/view";
import { DEFAULT_SETTINGS, type Analysis } from "../src/types";
import { createHeadlessRenderer } from "../tests/support/headless_render";

const ROOT = resolve(import.meta.dir, "..");
const SYNTHETIC = resolve(ROOT, "tests/fixtures/analyses/corpus.json");
const ANALYSES = resolve(ROOT, "tests/fixtures/analyses");
const REFERENCES = [
  ["Focus", 3884482881],
  ["Minimum", 3884482841],
  ["Karma", 3884482861],
  ["Gogo", 1794963897],
] as const;

interface Track {
  name: string;
  analysis: Analysis;
}

const synthetic = JSON.parse(readFileSync(SYNTHETIC, "utf8")) as Array<{ name: string; analysis: Analysis }>;
const tracks: Track[] = [
  ...synthetic.map((entry) => ({ name: `synth:${entry.name}`, analysis: entry.analysis })),
  ...REFERENCES.map(([name, id]) => ({
    name: `ref:${name}`,
    analysis: JSON.parse(readFileSync(resolve(ANALYSES, `real-${id}.json`), "utf8")) as Analysis,
  })),
];

const renderer = await createHeadlessRenderer();
let windowsOverBudget = 0;
let postDropFlashes = 0;
let reducedMaxWhite = 0;
let reducedDrops = 0;
try {
  for (const track of tracks) {
    const analysis = track.analysis;
    const view = createTrackView(analysis);
    const events: number[] = [];
    let wasAdmitted = false;
    for (let time = 0; time < analysis.duration; time += 1 / 120) {
      const admitted = flashAdmitted(view, time);
      if (admitted && !wasAdmitted) events.push(Number(time.toFixed(4)));
      wasAdmitted = admitted;
    }
    const windows = events.filter(
      (time) => events.filter((other) => other >= time && other < time + 1).length > 3,
    );
    windowsOverBudget += windows.length;

    let post = 0;
    for (const drop of analysis.drops ?? []) {
      // L'impact audible peut être la fin de montée qui coïncide avec la
      // reprise : on mesure après cet impact réel, pas après l'estimation.
      const impacts = (analysis.builds ?? [])
        .map((build) => build.end)
        .filter((end) => end >= drop.time - 0.2 && end <= drop.time + 0.8);
      const impact = Math.max(drop.time, ...impacts);
      post += events.filter((time) => time > impact + 0.15 && time <= impact + 1.5).length;
    }
    postDropFlashes += post;

    await renderer.setup({
      analysis,
      reduced: true,
      width: 1920,
      height: 1080,
      dpr: 1,
      quality: 1,
      settings: { ...DEFAULT_SETTINGS, reduced: true },
      reducedMotion: true,
    });
    for (const drop of analysis.drops ?? []) {
      const at = Math.min(analysis.duration, drop.time + 0.1);
      const capture = await renderer.capture(at, Math.round(at * 60));
      reducedMaxWhite = Math.max(reducedMaxWhite, capture.whiteRatio);
      reducedDrops += 1;
    }

    console.log(
      `${track.name.padEnd(30)} flashes=${String(events.length).padStart(3)} ` +
        `fenêtres>3/s=${windows.length} post-1,5s=${post} drops=${(analysis.drops ?? []).length}`,
    );
  }
} finally {
  await renderer.close();
}

console.log(
  `TOTAL fenêtres>3/s=${windowsOverBudget} flashs post-drop=${postDropFlashes} ` +
    `blanc réduit max=${reducedMaxWhite.toFixed(3)} (${reducedDrops} drops)`,
);
const ok = windowsOverBudget === 0 && postDropFlashes === 0 && reducedMaxWhite <= 0.02;
console.log(ok ? "SÉCURITÉ OK" : "SÉCURITÉ EN ÉCHEC");
process.exit(ok ? 0 : 1);
