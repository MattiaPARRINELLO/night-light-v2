import { describe, expect, it } from "bun:test";
import { EMPTY_LIVE_AUDIO, type LiveAudioFeatures } from "../../src/core/liveAudio";
import { LiveDirector } from "../../src/core/liveDirector";

/** Échantillon de capture avec un horodatage strictement croissant. */
function sample(
  updatedAt: number,
  overrides: Partial<LiveAudioFeatures> = {},
): LiveAudioFeatures {
  return {
    ...EMPTY_LIVE_AUDIO,
    state: "active",
    updatedAt,
    rms: 0.25,
    energy: 0.25,
    bass: 0.5,
    mid: 0.3,
    high: 0.2,
    ...overrides,
  };
}

/** Fait tourner le directeur à 60 img/s sur une durée donnée. */
function run(
  director: LiveDirector,
  from: number,
  to: number,
  features: (t: number) => LiveAudioFeatures,
): number {
  let t = from;
  while (t <= to) {
    director.update(t, features(t));
    t += 1 / 60;
  }
  return to;
}

describe("LiveDirector", () => {
  it("détecte des temps forts et estime le tempo", () => {
    const director = new LiveDirector();
    const startedAt = 0;
    const end = run(director, startedAt, 6, (t) => {
      // Un temps fort toutes les 0,5 s : 120 BPM.
      const phase = t % 0.5;
      const transient = phase < 0.09 ? 0.75 : 0.03;
      // L'horodatage change à chaque passage : la détection ne tourne que sur
      // un nouvel échantillon.
      return sample(Math.round(t * 1000), { transient, rms: 0.3 });
    });
    expect(end).toBeGreaterThan(0);
    const music = director.update(end, sample(999_999, { transient: 0.03 }));
    expect(music.beatIndex).toBeGreaterThanOrEqual(8);
    expect(music.bpm).toBeGreaterThan(90);
    expect(music.bpm).toBeLessThan(150);
    expect(music.beatInterval).toBeGreaterThan(0.3);
    expect(music.beatInterval).toBeLessThan(0.8);
  });

  it("ouvre un impact sur un saut de niveau", () => {
    const director = new LiveDirector();
    let t = 0;
    // Deux secondes calmes, puis un saut franc.
    while (t < 2) {
      director.update(t, sample(Math.round(t * 1000), { rms: 0.06, energy: 0.06, transient: 0.02 }));
      t += 1 / 60;
    }
    const afterJump = (() => {
      while (t < 2.4) {
        const music = director.update(
          t,
          sample(Math.round(t * 1000), { rms: 0.45, energy: 0.45, transient: 0.6, bass: 0.6 }),
        );
        t += 1 / 60;
        if (music.drop > 0.2) return music;
      }
      return director.update(t, sample(999_000, { rms: 0.45, energy: 0.45 }));
    })();
    expect(afterJump.drop).toBeGreaterThan(0.2);
    expect(afterJump.impactStrength).toBeGreaterThan(0.2);
    expect(Number.isFinite(afterJump.dropAge)).toBe(true);
    expect(afterJump.admitted).toBe(true);
  });

  it("retombe au silence sans garder une image musicale figée", () => {
    const director = new LiveDirector();
    const end = run(director, 0, 3, (t) =>
      sample(Math.round(t * 1000), { rms: 0.3, transient: t % 0.5 < 0.09 ? 0.8 : 0.03 }),
    );
    // Trois secondes de silence, avec un horodatage qui avance encore.
    const silentEnd = run(director, end, end + 3, (t) =>
      sample(Math.round(t * 1000), { ...EMPTY_LIVE_AUDIO, state: "silent", updatedAt: Math.round(t * 1000) }),
    );
    const music = director.update(silentEnd, {
      ...EMPTY_LIVE_AUDIO,
      state: "silent",
      updatedAt: 99_999,
    });
    expect(music.level).toBeLessThan(0.02);
    expect(music.energy).toBeLessThan(0.05);
    expect(music.beat).toBeLessThan(0.02);
    expect(music.build).toBe(0);
    expect(music.admitted).toBe(false);
  });

  it("suit une montée d'énergie", () => {
    const director = new LiveDirector();
    let music = director.update(0, sample(0, { rms: 0.05, energy: 0.05, transient: 0.01 }));
    let t = 0;
    // Montée progressive sur quatre secondes.
    for (let index = 0; index < 48; index += 1) {
      t += 1 / 12;
      const level = 0.05 + (index / 48) * 0.35;
      music = director.update(t, sample(index + 1, { rms: level, energy: level, transient: 0.02 }));
    }
    expect(music.build).toBeGreaterThan(0.1);
    expect(music.surge).toBeGreaterThan(0.05);
  });

  it("ignore les valeurs non finies", () => {
    const director = new LiveDirector();
    const music = director.update(1, {
      ...EMPTY_LIVE_AUDIO,
      state: "active",
      updatedAt: 1,
      rms: Number.NaN,
      energy: Number.NaN,
      transient: Number.NaN,
    });
    expect(music.level).toBe(0);
    expect(music.drop).toBe(0);
    expect(music.bpm).toBe(0);
  });
});
