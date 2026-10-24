/**
 * Diagnostic chiffré du contrat de couleur et de la photosensibilité.
 *
 * Lancement : `bun tests/support/render_diagnostic.ts [--json]`
 *
 * Trace, pour une scène synthétique et six pistes de corpus déterministes :
 * - `sceneHue(t)` sur 0..600 s (pas 0,5 s) et l'écart maximal à l'ancre ;
 * - le plus grand |Δ teinte| entre deux images à 60 fps, sauts d'impact exclus ;
 * - les instants d'admission de flash et l'écart minimal entre deux flashs.
 *
 * Les pistes sont des analyses synthétiques (pas de dépendance au serveur) :
 * tempos, palettes et nombre de montées varient, une piste n'a aucune basse et
 * une autre a exactement trois montées.
 */
import { buildShowPlan } from "../../src/core/show";
import { beatStrength, flashAdmitted, flashAlphaAt, sceneHue, visibleEnergy } from "../../src/core/render";
import { TrackView } from "../../src/core/view";
import { DEFAULT_SETTINGS, type Analysis } from "../../src/types";

const DURATION = 600;
const FRAME = 1 / 60;

interface CorpusTrack {
  name: string;
  analysis: Analysis;
}

function beatGrid(tempo: number, duration = DURATION): number[] {
  const period = 60 / tempo;
  const beats: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += period) beats.push(Number(t.toFixed(4)));
  return beats;
}

function makeTrack(name: string, tempo: number, kickLevel: number, builds: Analysis["builds"]): CorpusTrack {
  const beats = beatGrid(tempo);
  const period = 60 / tempo;
  const sections = [0, 1, 2, 3, 4, 5].map((index) => ({
    start: index * 100,
    end: (index + 1) * 100,
    label: (index % 2 === 0 ? "calme" : "montee") as Analysis["sections"][number]["label"],
    energy: 0.3 + (index % 3) * 0.3,
  }));
  return {
    name,
    analysis: {
      schema: 2,
      duration: DURATION,
      tempo,
      beatCount: beats.length,
      beatPeriod: period,
      beats,
      onsets: beats.map((beat) => Number((beat + period / 2).toFixed(4))),
      energy: [
        [0, 0.35],
        [200, 0.6],
        [400, 0.9],
        [DURATION, 0.5],
      ],
      bass: [
        [0, kickLevel],
        [DURATION, kickLevel],
      ],
      mid: [
        [0, 0.4],
        [DURATION, 0.6],
      ],
      high: [
        [0, 0.3],
        [DURATION, 0.7],
      ],
      sections,
      builds,
    },
  };
}

const CORPUS: CorpusTrack[] = [
  makeTrack("bpm90 sans montée", 90, 0.85, []),
  makeTrack("bpm110 une montée", 110, 0.8, [{ start: 120, end: 124, strength: 0.7 }]),
  makeTrack("bpm128 deux montées", 128, 0.9, [
    { start: 100, end: 104, strength: 0.8 },
    { start: 420, end: 425, strength: 0.9 },
  ]),
  makeTrack("bpm140 trois montées", 140, 0.9, [
    { start: 90, end: 94, strength: 0.7 },
    { start: 280, end: 284, strength: 0.8 },
    { start: 470, end: 475, strength: 0.9 },
  ]),
  makeTrack("bpm100 sans basses", 100, 0.02, [{ start: 200, end: 204, strength: 0.6 }]),
  makeTrack("bpm122 cinq montées", 122, 0.75, [
    { start: 60, end: 64, strength: 0.6 },
    { start: 150, end: 154, strength: 0.7 },
    { start: 240, end: 244, strength: 0.8 },
    { start: 330, end: 334, strength: 0.85 },
    { start: 480, end: 485, strength: 0.95 },
  ]),
];

/** Écart angulaire signé, dans ]-180 ; 180]. */
function delta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/** Ancre de la scène : la teinte du morceau dont elle est la plus proche. */
function anchorFor(scene: ReturnType<typeof buildShowPlan>["scenes"][number], track: { hue: number; accent: number }): number {
  return Math.abs(delta(scene.palette.hue, track.accent)) < Math.abs(delta(scene.palette.hue, track.hue))
    ? track.accent
    : track.hue;
}

interface TrackReport {
  name: string;
  spread: number;
  hueMaxFromAnchor: number;
  budget: number;
  hueMaxStepDeg: number;
  hueMaxStepOutsideImpactDeg: number;
  sceneHueSamples: Array<[number, number]>;
  flashCount: number;
  flashesPerMinute: number;
  flashMinGap: number;
  maxFlashAlpha: number;
  dropFlashCount: number;
}

function diagnose(track: CorpusTrack, seed: number): TrackReport {
  const plan = buildShowPlan(track.analysis, false, seed);
  const view = new TrackView(track.analysis);
  const scenes = plan.scenes;

  let maxFromAnchor = 0;
  let maxStep = 0;
  let maxStepOutsideImpact = 0;
  const samples: Array<[number, number]> = [];

  const hueAt = (t: number): { hue: number; anchor: number; spread: number } => {
    const scene = scenes.find((candidate) => t >= candidate.start && t < candidate.end) ?? scenes[scenes.length - 1]!;
    const anchor = anchorFor(scene, plan.track);
    const drop = view.buildIntensity(t);
    const variation = 0;
    return { hue: sceneHue(scene, t, drop, variation, false, anchor), anchor, spread: scene.palette.spread };
  };

  for (let t = 0; t <= DURATION; t += 0.5) {
    const { hue, anchor, spread } = hueAt(t);
    const distance = Math.abs(delta(anchor, hue));
    if (distance > maxFromAnchor) maxFromAnchor = distance;
    samples.push([Number(t.toFixed(1)), Number(hue.toFixed(2))]);
    void spread;
  }

  for (let t = 0; t + FRAME <= DURATION; t += FRAME) {
    const a = hueAt(t);
    const b = hueAt(t + FRAME);
    const step = Math.abs(delta(a.hue, b.hue));
    if (step > maxStep) maxStep = step;
    // Un saut est « explicite » quand une fin de montée tombe entre les deux
    // images (drop) ou quand la scène change : le fondu de scène est géré par
    // le rendu (poids croisés), pas par `sceneHue`.
    const impact =
      view.buildsEndingIn(t, t + FRAME).length > 0 ||
      scenes.some((scene) => scene.start > t && scene.start <= t + FRAME);
    if (!impact && step > maxStepOutsideImpact) maxStepOutsideImpact = step;
  }

  const flashEvents: number[] = [];
  let wasAdmitted = false;
  let maxFlashAlpha = 0;
  let dropFlashCount = 0;
  for (let t = 0; t <= DURATION; t += FRAME) {
    const admitted = flashAdmitted(view, t);
    const alpha = flashAlphaAt(
      beatStrength(view, t),
      view.bassAt(t),
      view.buildProgress(t),
      view.buildAt(t)?.strength ?? 0,
      visibleEnergy(view.energyAt(t)),
      false,
      { ...DEFAULT_SETTINGS, flashes: 1 },
    );
    if (alpha > maxFlashAlpha) maxFlashAlpha = alpha;
    if (admitted && !wasAdmitted) {
      flashEvents.push(Number(t.toFixed(3)));
      if (view.buildsEndingIn(t - 1.5, t).length > 0) dropFlashCount += 1;
    }
    wasAdmitted = admitted;
  }
  let minGap = Infinity;
  for (let i = 1; i < flashEvents.length; i += 1) {
    minGap = Math.min(minGap, flashEvents[i]! - flashEvents[i - 1]!);
  }

  return {
    name: track.name,
    spread: scenes[0]?.palette.spread ?? 0,
    hueMaxFromAnchor: Number(maxFromAnchor.toFixed(3)),
    budget: (scenes[0]?.palette.spread ?? 0) + 12,
    hueMaxStepDeg: Number(maxStep.toFixed(3)),
    hueMaxStepOutsideImpactDeg: Number(maxStepOutsideImpact.toFixed(3)),
    sceneHueSamples: samples,
    flashCount: flashEvents.length,
    flashesPerMinute: Number(((flashEvents.length / DURATION) * 60).toFixed(2)),
    flashMinGap: Number.isFinite(minGap) ? Number(minGap.toFixed(3)) : Infinity,
    maxFlashAlpha: Number(maxFlashAlpha.toFixed(3)),
    dropFlashCount,
  };
}

const SCENE_REPORT = diagnose(CORPUS[0]!, 41);

const reports = CORPUS.map((track, index) => diagnose(track, index * 7 + 3));

const json = process.argv.includes("--json");
if (json) {
  console.log(JSON.stringify({ scene: SCENE_REPORT, corpus: reports }, null, 2));
} else {
  console.log("piste                          spread  |hue-ancre| max  budget  Δhue/60fps  hors impact  flashs/min  écart min  alpha max  flashs drop");
  for (const report of reports) {
    console.log(
      `${report.name.padEnd(30)} ${String(report.spread).padStart(6)} ${report.hueMaxFromAnchor
        .toFixed(2)
        .padStart(17)} ${String(report.budget).padStart(7)} ${report.hueMaxStepDeg
        .toFixed(3)
        .padStart(11)} ${report.hueMaxStepOutsideImpactDeg.toFixed(3).padStart(12)} ${report.flashesPerMinute
        .toFixed(2)
        .padStart(11)} ${String(report.flashMinGap).padStart(10)} ${report.maxFlashAlpha.toFixed(3).padStart(9)} ${String(
        report.dropFlashCount,
      ).padStart(11)}`,
    );
  }
  console.log(`\nScène synthétique (${SCENE_REPORT.name}) :`);
  console.log(`  |hue − ancre| max = ${SCENE_REPORT.hueMaxFromAnchor}° (budget ${SCENE_REPORT.budget}°)`);
  console.log(`  Δhue/60 fps max = ${SCENE_REPORT.hueMaxStepDeg}° (hors impact ${SCENE_REPORT.hueMaxStepOutsideImpactDeg}°)`);
  console.log(
    `  flashs = ${SCENE_REPORT.flashCount} (${SCENE_REPORT.flashesPerMinute}/min), écart min = ${SCENE_REPORT.flashMinGap} s, alpha max = ${SCENE_REPORT.maxFlashAlpha}, flashs de drop = ${SCENE_REPORT.dropFlashCount}`,
  );
  console.log(`  premiers échantillons sceneHue : ${SCENE_REPORT.sceneHueSamples.slice(0, 6).map(([t, h]) => `${t}s=${h}°`).join(", ")}`);
}
