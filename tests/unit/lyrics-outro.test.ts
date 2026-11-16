import { describe, expect, test } from "bun:test";

import { outroStateAt } from "../../src/core/lyrics";
import { renderFrame } from "../../src/core/render";
import { buildShowPlan } from "../../src/core/show";
import { TrackView } from "../../src/core/view";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { Analysis, LyricLine, LyricsCues } from "../../src/types";
import { fakeContext } from "../support/fake_canvas";

function lyrics(lines: LyricLine[]): LyricsCues {
  return {
    recordId: 1,
    wordSynced: lines.some((line) => line.words.length > 0),
    keywords: [],
    chorusLines: [],
    lines,
    source: "heuristic",
  };
}

function line(text: string, startSec: number, endSec: number, words: string[] = []): LyricLine {
  const span = Math.max(1, endSec - startSec);
  return {
    text,
    startMs: startSec * 1000,
    endMs: endSec * 1000,
    words: words.map((word, index) => {
      const from = startSec + (span * index) / words.length;
      const to = startSec + (span * (index + 1)) / words.length;
      return { text: word, startMs: Math.round(from * 1000), endMs: Math.round(to * 1000) };
    }),
  };
}

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    schema: 2,
    duration: 40,
    tempo: 120,
    beatCount: 80,
    beatPeriod: 0.5,
    beats: Array.from({ length: 81 }, (_, index) => index * 0.5),
    onsets: [],
    energy: [
      [0, 0.3],
      [20, 0.6],
      [40, 0.2],
    ],
    bass: [
      [0, 0.5],
      [40, 0.4],
    ],
    mid: [
      [0, 0.4],
      [40, 0.3],
    ],
    high: [
      [0, 0.3],
      [40, 0.2],
    ],
    sections: [],
    builds: [],
    ...overrides,
  };
}

describe("extinction de fin de morceau", () => {
  test("sans paroles, la scène ne s'éteint pas", () => {
    expect(outroStateAt(undefined, 30, 40)).toEqual({ fade: 1, lyre: 0 });
    expect(outroStateAt(lyrics([]), 30, 40)).toEqual({ fade: 1, lyre: 0 });
  });

  test("le morceau se termine sur la voix : pas d'extinction", () => {
    const cues = lyrics([line("dernière phrase", 10, 40, ["dernière", "phrase"])]);
    expect(outroStateAt(cues, 39, 40)).toEqual({ fade: 1, lyre: 0 });
  });

  test("après la dernière parole, la lumière descend jusqu'au noir", () => {
    const cues = lyrics([line("la fin", 0, 20, ["la", "fin"])]);
    expect(outroStateAt(cues, 20, 40).fade).toBeCloseTo(1, 5);
    const middle = outroStateAt(cues, 30, 40);
    expect(middle.fade).toBeGreaterThan(0);
    expect(middle.fade).toBeLessThan(1);
    expect(outroStateAt(cues, 40, 40).fade).toBe(0);
  });

  test("la descente est monotone : jamais un retour de lumière", () => {
    const cues = lyrics([line("la fin", 0, 20, ["la", "fin"])]);
    let previous = 1;
    for (let t = 20; t <= 40; t += 0.25) {
      const fade = outroStateAt(cues, t, 40).fade;
      expect(fade).toBeLessThanOrEqual(previous + 1e-9);
      previous = fade;
    }
  });

  test("un dernier mot isolé garde une seule lyre allumée", () => {
    const cues = lyrics([
      line("une phrase entière", 5, 20, ["une", "phrase", "entière"]),
      line("ouais", 30, 31, ["ouais"]),
    ]);
    const pendantLeMot = outroStateAt(cues, 30.5, 40);
    expect(pendantLeMot.fade).toBeLessThan(1);
    expect(pendantLeMot.lyre).toBeGreaterThan(0);
    // Le rappel s'arrête avec le mot, même si le noir n'est pas encore complet.
    expect(outroStateAt(cues, 35, 40).lyre).toBe(0);
    // Et le morceau finit bien complètement noir.
    expect(outroStateAt(cues, 40, 40).fade).toBe(0);
  });

  test("une vraie phrase finale n'est pas traitée comme un rappel", () => {
    const cues = lyrics([
      line("une phrase entière", 5, 20, ["une", "phrase", "entière"]),
      line("ce n'est pas un rappel", 30, 31, ["ce", "n'est", "pas", "un", "rappel"]),
    ]);
    expect(outroStateAt(cues, 30.5, 40).lyre).toBe(0);
  });
});

describe("noir final au rendu", () => {
  test("la scène s'éteint mais la barre du cadre reste allumée", () => {
    const data = analysis({ lyrics: lyrics([line("la fin", 0, 20, ["la", "fin"])]) });
    const { ctx, operations } = fakeContext();
    renderFrame({
      ctx,
      width: 640,
      height: 360,
      dpr: 1,
      time: 40,
      view: new TrackView(data),
      plan: buildShowPlan(data, false),
      settings: DEFAULT_SETTINGS,
      reducedMotion: false,
      quality: 1,
      frame: 2400,
    });
    // Le noir final couvre tout l'écran...
    const noir = operations.lastIndexOf("fillStyle:#000");
    expect(noir).toBeGreaterThan(-1);
    expect(operations.slice(noir)).toContain("fillRect:0.0,0.0,640.0,360.0");
    // ... puis la bordure est redessinée par-dessus : les diodes restent la
    // seule lumière de l'image.
    expect(operations.slice(noir).some((operation) => operation.startsWith("arc:"))).toBe(true);
  });

  test("sans paroles, aucun voile de fin n'est ajouté", () => {
    const data = analysis();
    const { ctx, operations } = fakeContext();
    renderFrame({
      ctx,
      width: 640,
      height: 360,
      dpr: 1,
      time: 40,
      view: new TrackView(data),
      plan: buildShowPlan(data, false),
      settings: DEFAULT_SETTINGS,
      reducedMotion: false,
      quality: 1,
      frame: 2400,
    });
    expect(operations).not.toContain("fillStyle:#000");
  });
});
