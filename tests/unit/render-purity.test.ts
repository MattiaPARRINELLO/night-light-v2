/**
 * Pureté du rendu : l'image à `t` ne dépend que de `t`, du plan et de l'analyse.
 *
 * Pour trois morceaux du corpus, on rend en continu `0 → t` sur un canvas, puis
 * on rend `t` seul sur un canvas neuf (seek). Les pixels doivent être
 * strictement identiques (0 pixel, delta 0), sans préchauffage.
 *
 * Le harnais remet le contexte à zéro avant chaque image : Chromium conserve
 * sinon un cache de rastérisation interne au canvas qui décale 1 à 4 niveaux
 * selon l'historique (146 px / 57 600 mesurés, cause documentée dans
 * `tests/metrics/README.md`). Ce reset neutralise le moteur, pas le rendu :
 * aucun état applicatif ne subsiste entre deux images.
 *
 * `renderFrame` remet lui aussi le contexte à zéro sur la première image qui
 * suit un seek, mais cette remise à zéro côté production ne suffit pas à faire
 * passer la comparaison continue ↔ seek : le canvas continu garde, lui, son
 * historique. Le harnais conserve donc son reset (mesuré : 672 px / delta 9
 * sans lui).
 *
 * Le rendu passe par Chromium headless (vrai canvas 2D), pas par un faux
 * contexte : une différence de pixels serait une vraie régression.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { buildShowPlan } from "../../src/core/show";
import { DEFAULT_SETTINGS } from "../../src/types";
import { loadCorpusAnalyses, type PlanTrack } from "../support/plan_corpus";
import { createHeadlessRenderer, type HeadlessRenderer } from "../support/headless_render";

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 10;

let renderer: HeadlessRenderer;
let tracks: PlanTrack[];
let selected: PlanTrack[];

function setupOf(track: PlanTrack) {
  return {
    analysis: track.analysis,
    reduced: false,
    width: WIDTH,
    height: HEIGHT,
    dpr: 1,
    quality: 1,
    settings: DEFAULT_SETTINGS,
    reducedMotion: false,
  };
}

function measureTimes(track: PlanTrack): number[] {
  const plan = buildShowPlan(track.analysis, false);
  const first = plan.scenes[0];
  const second = plan.scenes[1];
  const mid = first === undefined ? plan.duration / 2 : Math.max(1, first.end - 1);
  const boundary = second === undefined ? plan.duration * 0.6 : Math.min(plan.duration - 0.5, second.start + 0.25);
  return [mid, boundary];
}

beforeAll(async () => {
  tracks = loadCorpusAnalyses();
  const names = ["60bpm", "128bpm", "rich"];
  selected = names.map((name) => {
    const track = tracks.find((candidate) => candidate.name === name);
    if (track === undefined) throw new Error(`piste absente du corpus : ${name}`);
    return track;
  });
  renderer = await createHeadlessRenderer();
}, 120_000);

afterAll(async () => {
  await renderer?.close();
});

describe("pureté du rendu", () => {
  // `ctx.reset()` (dans le harnais) neutralise le cache de rastérisation Skia
  // du canvas ; il ne masque aucun état applicatif. Résidu sans reset : 672 px
  // / 57 600, delta max 9 niveaux (mesuré après l'ajout du reset de seek côté
  // production). Le harnais garde son reset parce que le canvas continu, lui,
  // n'en reçoit pas.
  test(
    "rendu continu puis seek : pixels strictement identiques, sans préchauffage",
    async () => {
      for (const track of selected) {
        for (const time of measureTimes(track)) {
          const result = await renderer.compareContinuousSeek({
            ...setupOf(track),
            time,
            fps: FPS,
          });
          expect(result.totalPixels).toBe(WIDTH * HEIGHT * 1);
          expect(result.scenes).toBeGreaterThan(0);
          expect({
            track: track.name,
            time: result.time,
            diffPixels: result.diffPixels,
            maxDelta: result.maxDelta,
            hashContinuous: result.hashContinuous,
            hashSeek: result.hashSeek,
            diffBBox: result.diffBBox,
          }).toEqual({
            track: track.name,
            time: result.time,
            diffPixels: 0,
            maxDelta: 0,
            hashContinuous: result.hashContinuous,
            hashSeek: result.hashContinuous,
            diffBBox: null,
          });
        }
      }
    },
    240_000,
  );

  test(
    "l'image n'est pas vide (garde-fou de mesure)",
    async () => {
      const track = selected[1]!;
      await renderer.setup(setupOf(track));
      const stats = await renderer.imageStats(10, 100);
      expect(stats.total).toBe(WIDTH * HEIGHT);
      expect(stats.hash).toMatch(/^[0-9a-f]{8}$/);
      expect(stats.whiteRatio).toBeGreaterThanOrEqual(0);
      expect(stats.whiteRatio).toBeLessThanOrEqual(1);
    },
    120_000,
  );
});
