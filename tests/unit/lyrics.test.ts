import { describe, expect, it } from "bun:test";

import { drawLyrics } from "../../src/core/lyrics";
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

function drawnText(lyrics: LyricsCues, timeSec: number): string[] {
  const { ctx, operations } = fakeContext();
  drawLyrics(ctx, lyrics, timeSec, 1920, 1080, { palette, reduced: false, beat: 0 });
  return operations.filter((operation) => operation.startsWith("fillText:"));
}

describe("rendu des paroles", () => {
  it("garde le motif répété visible dès le début de la phrase", () => {
    // Le mot revient en fin de phrase : la ligne restait muette jusque-là.
    const lyrics = cues([
      line({ text: "Soleil dans la bulle, sur le Prado, Shifter pro' (Shifter pro')" }),
    ]);

    expect(drawnText(lyrics, 0.5)).toContain("fillText:SHIFTER");
    expect(drawnText(lyrics, 2.2)).toContain("fillText:SHIFTER");
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
      for (let ms = item.startMs + 200; ms < item.endMs - 200; ms += 100) {
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
