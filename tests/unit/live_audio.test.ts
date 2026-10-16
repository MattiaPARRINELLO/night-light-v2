import { describe, expect, it } from "bun:test";
import {
  EMPTY_LIVE_AUDIO,
  clampLiveLevel,
  isSilent,
  normalizeLiveLevels,
  smoothFeature,
  smoothLiveFeatures,
} from "../../src/core/liveAudio";

describe("live audio normalization", () => {
  it("clamps extreme values", () => {
    expect(clampLiveLevel(NaN)).toBe(0);
    expect(clampLiveLevel(Infinity)).toBe(0);
    expect(clampLiveLevel(-1)).toBe(0);
    expect(clampLiveLevel(2)).toBe(1);
    expect(clampLiveLevel(0.42)).toBe(0.42);
  });

  it("normalizes records and balances bands", () => {
    const result = normalizeLiveLevels({ rms: 1.2, bass: 0, mid: 0, high: 0, transient: 4, state: "active" });
    expect(result.rms).toBe(1);
    expect(result.transient).toBe(1);
    expect(result.bass).toBeCloseTo(1 / 3);
    expect(result.state).toBe("active");
  });

  it("uses fallback rms for energy", () => {
    const result = normalizeLiveLevels({ rms: 0.3 });
    expect(result.energy).toBe(0.3);
  });

  it("smooths features progressively", () => {
    const next = { ...EMPTY_LIVE_AUDIO, rms: 1, energy: 1, state: "active", updatedAt: 1 };
    const smoothed = smoothLiveFeatures(EMPTY_LIVE_AUDIO, next, 1);
    expect(smoothed.rms).toBe(1);
    const partial = smoothLiveFeatures(EMPTY_LIVE_AUDIO, next, 0.25);
    expect(partial.rms).toBeCloseTo(0.25);
  });

  it("reports silence", () => {
    expect(isSilent({ ...EMPTY_LIVE_AUDIO, state: "silent" })).toBe(true);
    expect(isSilent({ ...EMPTY_LIVE_AUDIO, rms: 0 })).toBe(true);
    expect(isSilent({ ...EMPTY_LIVE_AUDIO, rms: 0.5 })).toBe(false);
  });

  it("smoothFeature handles invalid smoothing", () => {
    expect(smoothFeature(0.2, 0.8, NaN)).toBeCloseTo(0.2);
  });
});
