/**
 * Tests de l'instrumentation de saturation : définition du blanc, fenêtres de
 * drops et échantillonnage à 10 Hz. Aucun canvas ici : le renderer est simulé,
 * ce qui vérifie la logique sans dépendre de Chromium.
 */

import { describe, expect, test } from "bun:test";

import { buildShowPlan } from "../../src/core/show";
import type { Analysis } from "../../src/types";
import {
  aggregateSaturation,
  dropWindows,
  sampleDrops,
  sampleTimes,
  SATURATION_FPS,
} from "../support/drop_saturation";
import { nearWhiteRatio, whitePixels } from "../support/saturation";

function rgba(pixels: Array<[number, number, number]>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b], index) => {
    out[index * 4] = r;
    out[index * 4 + 1] = g;
    out[index * 4 + 2] = b;
    out[index * 4 + 3] = 255;
  });
  return out;
}

function analysis(): Analysis {
  return {
    schema: 2,
    duration: 30,
    tempo: 120,
    meter: 4,
    beatCount: 60,
    beatPeriod: 0.5,
    beats: Array.from({ length: 60 }, (_, index) => index * 0.5),
    onsets: Array.from({ length: 60 }, (_, index) => index * 0.5 + 0.25),
    energy: [
      [0, 0.4],
      [10, 0.9],
      [30, 0.5],
    ],
    bass: [
      [0, 0.4],
      [30, 0.5],
    ],
    mid: [
      [0, 0.4],
      [30, 0.5],
    ],
    high: [
      [0, 0.2],
      [30, 0.3],
    ],
    // Section globale : elle ne pilote ni rôle ni humeur locale, ce qui laisse
    // la fin de montée produire un vrai rôle `drop`.
    sections: [{ start: 0, end: 30, label: "intense", energy: 0.8, kind: "section" }],
    builds: [{ start: 12, end: 16, strength: 1 }],
  };
}

describe("définition du pixel proche du blanc", () => {
  test("le blanc pur compte, le noir et le rouge non", () => {
    expect(nearWhiteRatio(rgba([[255, 255, 255]]))).toBe(1);
    expect(nearWhiteRatio(rgba([[0, 0, 0]]))).toBe(0);
    expect(nearWhiteRatio(rgba([[255, 0, 0]]))).toBe(0);
    expect(nearWhiteRatio(rgba([[255, 0, 255]]))).toBe(0);
  });

  test("les seuils de luminance 0,92 et de saturation 0,15 sont respectés", () => {
    // Luminance 0,9216 : tout juste au-dessus du seuil, saturation nulle.
    expect(nearWhiteRatio(rgba([[235, 235, 235]]))).toBe(1);
    // Luminance 0,902 : sous le seuil.
    expect(nearWhiteRatio(rgba([[230, 230, 230]]))).toBe(0);
    // Crème : luminance 0,978, saturation 0,04.
    expect(nearWhiteRatio(rgba([[250, 250, 240]]))).toBe(1);
    // Saturation seule, seuil de luminance abaissé pour isoler la condition :
    // 0,2 > 0,15 n'est pas compté, 0,098 l'est.
    expect(nearWhiteRatio(rgba([[255, 204, 204]]), { luminanceThreshold: 0.5 })).toBe(0);
    expect(nearWhiteRatio(rgba([[255, 230, 230]]), { luminanceThreshold: 0.5 })).toBe(1);
  });

  test("compte et part sur une image mixte", () => {
    const stats = whitePixels(
      rgba([
        [255, 255, 255],
        [0, 0, 0],
        [250, 250, 250],
        [10, 200, 30],
      ]),
    );
    expect(stats.total).toBe(4);
    expect(stats.white).toBe(2);
    expect(stats.ratio).toBe(0.5);
  });

  test("une image vide donne une part nulle sans division par zéro", () => {
    expect(whitePixels(new Uint8ClampedArray(0))).toEqual({ total: 0, white: 0, ratio: 0 });
  });
});

describe("échantillonnage des drops", () => {
  test("10 Hz couvre toute la fenêtre, sans dépasser la fin", () => {
    const times = sampleTimes(2, 2.35, SATURATION_FPS);
    expect(times).toEqual([2, 2.1, 2.2, 2.3]);
    expect(sampleTimes(4, 4.05, SATURATION_FPS)).toEqual([4]);
  });

  test("les fenêtres de drop viennent des scènes de rôle drop", () => {
    const plan = buildShowPlan(analysis(), false);
    const windows = dropWindows("test", plan);
    expect(windows.length).toBeGreaterThan(0);
    const first = windows[0]!;
    expect(first.track).toBe("test");
    expect(first.start).toBe(plan.scenes.find((scene) => scene.role === "drop")!.start);
    expect(first.signature === null || first.signature.split("/").length === 4).toBe(true);
  });

  test("sampleDrops interroge le renderer à 10 Hz et agrège les ratios", async () => {
    const track = { name: "test", analysis: analysis(), source: "corpus" as const };
    const calls: Array<{ times: number[]; fps: number }> = [];
    const ratios = [0.01, 0.02, 0.03, 0.04];
    let setups = 0;
    const fake = {
      async setup() {
        setups += 1;
        return { scenes: 1, width: 320, height: 180 };
      },
      async whiteRatios(times: number[], fps: number) {
        calls.push({ times: [...times], fps });
        return times.map((_, index) => ratios[index % ratios.length]!);
      },
    };

    const drops = await sampleDrops(fake, track);
    expect(setups).toBe(1);
    expect(calls.length).toBe(drops.length);
    expect(calls.every((call) => call.fps === 10)).toBe(true);
    expect(drops[0]!.times.length).toBeGreaterThan(1);
    expect(drops[0]!.stats.count).toBe(drops[0]!.times.length);
    expect(drops[0]!.max).toBeLessThanOrEqual(1);

    const aggregate = aggregateSaturation(drops);
    expect(aggregate.drops).toBe(drops.length);
    expect(aggregate.samples).toBe(drops.reduce((sum, drop) => sum + drop.ratios.length, 0));
    expect(aggregate.stats.mean).toBeGreaterThan(0);
  });

  test("aucun drop : aucun setup ni échantillon", async () => {
    const quiet = analysis();
    quiet.duration = 10;
    quiet.builds = [];
    quiet.sections = [{ start: 0, end: 10, label: "calme", energy: 0.3, kind: "couplet" }];
    quiet.beats = quiet.beats.filter((beat) => beat < 10);
    quiet.onsets = quiet.onsets.filter((onset) => onset < 10);
    quiet.energy = [
      [0, 0.3],
      [10, 0.3],
    ];
    const track = { name: "calme", analysis: quiet, source: "corpus" as const };
    let setups = 0;
    const fake = {
      async setup() {
        setups += 1;
        return { scenes: 1, width: 320, height: 180 };
      },
      async whiteRatios() {
        return [];
      },
    };
    expect(await sampleDrops(fake, track)).toEqual([]);
    expect(setups).toBe(0);
  });
});
