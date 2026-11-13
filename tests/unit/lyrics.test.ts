import { describe, expect, it } from "bun:test";

import { chorusIntensityAt, drawLyrics } from "../../src/core/lyrics";
import type { Palette } from "../../src/core/show";
import type { LyricLine, LyricsCues } from "../../src/types";
import { fakeContext } from "../support/fake_canvas";

const palette = {
  name: "test",
  hue: 280,
  accent: 200,
  saturation: 0.6,
} as unknown as Palette;

function line(overrides: Partial<LyricLine> = {}): LyricLine {
  return { text: "", startMs: 0, endMs: 3_000, words: [], ...overrides };
}

function cues(lines: LyricLine[], overrides: Partial<LyricsCues> = {}): LyricsCues {
  return {
    recordId: 1,
    wordSynced: lines.some((item) => item.words.length > 0),
    keywords: [],
    chorusLines: [],
    shoutLines: [],
    lines,
    source: "heuristic",
    ...overrides,
  };
}

function drawnText(lyrics: LyricsCues, timeSec: number, beat = 0): string[] {
  const { ctx, operations } = fakeContext();
  drawLyrics(ctx, lyrics, timeSec, 1920, 1080, { palette, reduced: false, beat });
  return operations.filter((operation) => operation.startsWith("fillText:"));
}

function drawnScales(lyrics: LyricsCues, timeSec: number, beat = 0): string[] {
  const { ctx, operations } = fakeContext();
  drawLyrics(ctx, lyrics, timeSec, 1920, 1080, { palette, reduced: false, beat });
  return operations.filter((operation) => operation.startsWith("scale:"));
}

function repeatedLine(): LyricsCues {
  return cues([
    line({
      text: "Soleil dans la bulle, Shifter pro' (Shifter pro')",
      words: [
        { text: "Soleil", startMs: 0, endMs: 600 },
        { text: "dans", startMs: 600, endMs: 900 },
        { text: "la", startMs: 900, endMs: 1_100 },
        { text: "bulle,", startMs: 1_100, endMs: 1_600 },
        { text: "Shifter", startMs: 1_600, endMs: 2_100 },
        { text: "pro'", startMs: 2_100, endMs: 2_400 },
        { text: "(Shifter", startMs: 2_400, endMs: 2_800 },
        { text: "pro')", startMs: 2_800, endMs: 3_000 },
      ],
    }),
  ]);
}

describe("rendu des paroles", () => {
  it("n'affiche le motif répété qu'au moment où il est chanté", () => {
    const lyrics = repeatedLine();

    // Avant le mot : la phrase se dit normalement, le motif n'est pas en avant.
    expect(drawnText(lyrics, 0.3)).toEqual(["fillText:SOLEIL"]);
    expect(drawnText(lyrics, 1.2)).toEqual(["fillText:BULLE,"]);

    // Au moment où il est chanté, le motif prend la scène.
    expect(drawnText(lyrics, 1.7)).toContain("fillText:SHIFTER");
  });

  it("frappe le motif à son occurrence sans battre avec le beat", () => {
    const lyrics = repeatedLine();

    // Le motif ne réagit pas au beat : même géométrie, quel que soit le temps fort.
    expect(drawnScales(lyrics, 1.7, 1)).toEqual(drawnScales(lyrics, 1.7, 0));

    // En revanche il frappe à son occurrence, puis se pose.
    const hit = drawnScales(lyrics, 1.62);
    const reste = drawnScales(lyrics, 1.95);
    expect(hit).not.toEqual(reste);
    expect(Number(hit[0]?.split(":")[1]?.split(",")[0])).toBeGreaterThan(
      Number(reste[0]?.split(":")[1]?.split(",")[0]),
    );
  });

  it("n'a aucun trou pendant une ligne, motif répété ou non", () => {
    const lines = [
      line({
        text: "Le J, c'est le S (ok), hum, j'sors le RS (vroum, vroum)",
        startMs: 0,
        endMs: 4_000,
      }),
      line({ text: "Une phrase sans répétition qui se chante normalement", startMs: 4_000, endMs: 7_000 }),
      line({
        text: "Jefe, Jefe, on arrivera sur le trône un peu blessé",
        startMs: 7_000,
        endMs: 11_000,
      }),
    ];
    const lyrics = cues(lines);

    for (const item of lines) {
      for (let ms = item.startMs + 220; ms < item.endMs - 220; ms += 70) {
        const texts = drawnText(lyrics, ms / 1000);
        expect(texts.length, `rien de dessiné à ${ms} ms`).toBeGreaterThan(0);
      }
    }
  });

  it("dessine le mot courant quand rien ne se répète", () => {
    const lyrics = cues([
      line({
        text: "premier deuxième troisième",
        words: [
          { text: "premier", startMs: 0, endMs: 500 },
          { text: "deuxième", startMs: 500, endMs: 1_200 },
          { text: "troisième", startMs: 1_200, endMs: 2_000 },
        ],
      }),
    ]);

    expect(drawnText(lyrics, 0.7)).toEqual(["fillText:DEUXIÈME"]);
  });
});

describe("refrain des paroles", () => {
  const refrain = (): LyricsCues =>
    cues(
      [
        line({ text: "couplet", startMs: 0, endMs: 8_000 }),
        line({ text: "refrain une", startMs: 10_000, endMs: 14_000 }),
        line({ text: "refrain deux", startMs: 15_000, endMs: 20_000 }),
        line({ text: "couplet final", startMs: 24_000, endMs: 30_000 }),
      ],
      { chorusLines: [1, 2] },
    );

  it("vaut zéro sans paroles ou hors refrain", () => {
    expect(chorusIntensityAt(undefined, 12)).toBe(0);
    expect(chorusIntensityAt(cues([line({ text: "a", startMs: 0, endMs: 5_000 })]), 2)).toBe(0);
    expect(chorusIntensityAt(refrain(), 5)).toBe(0);
    expect(chorusIntensityAt(refrain(), 22)).toBe(0);
  });

  it("monte à plein pendant le refrain et fond sur les bords", () => {
    const lyrics = refrain();

    expect(chorusIntensityAt(lyrics, 12)).toBeCloseTo(1, 5);
    // Les deux lignes séparées de 1 s forment un seul bloc : la salle ne
    // retombe pas entre les deux.
    expect(chorusIntensityAt(lyrics, 14.5)).toBeCloseTo(1, 5);
    // Entrée et sortie progressives, jamais un interrupteur.
    expect(chorusIntensityAt(lyrics, 10.1)).toBeGreaterThan(0);
    expect(chorusIntensityAt(lyrics, 10.1)).toBeLessThan(1);
    expect(chorusIntensityAt(lyrics, 19.8)).toBeGreaterThan(0);
    expect(chorusIntensityAt(lyrics, 19.8)).toBeLessThan(1);
  });
});
