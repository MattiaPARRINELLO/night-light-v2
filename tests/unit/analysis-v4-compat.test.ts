/**
 * Compatibilité V3.1 — une analyse « version 4 » (sections sans kind, group ni
 * confidence) doit produire exactement le même plan qu'avant la vague 3.
 *
 * Le test fige l'empreinte du plan : si un champ optionnel nouveau modifiait le
 * comportement d'un consommateur ancien, l'empreinte changerait.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { buildShowPlan } from "../../src/core/show";
import type { Analysis } from "../../src/types";
import { stableStringify } from "../support/plan_snapshot";

const LEGACY_ANALYSIS: Analysis = {
  schema: 2,
  duration: 40,
  tempo: 120,
  meter: 4,
  beatCount: 80,
  beatPeriod: 0.5,
  beats: Array.from({ length: 80 }, (_, index) => index * 0.5),
  onsets: Array.from({ length: 80 }, (_, index) => index * 0.5),
  energy: Array.from({ length: 40 }, (_, index) => [index, 0.5] as [number, number]),
  bass: Array.from({ length: 40 }, (_, index) => [index, 0.4] as [number, number]),
  mid: Array.from({ length: 40 }, (_, index) => [index, 0.5] as [number, number]),
  midLow: Array.from({ length: 40 }, (_, index) => [index, 0.5] as [number, number]),
  midHigh: Array.from({ length: 40 }, (_, index) => [index, 0.5] as [number, number]),
  high: Array.from({ length: 40 }, (_, index) => [index, 0.3] as [number, number]),
  // Section « version 4 » : ni kind, ni group, ni confidence.
  sections: [{ start: 0, end: 40, label: "intense", energy: 0.5 }],
  builds: [{ start: 20, end: 26, strength: 0.6 }],
};

describe("compatibilité analyse version 4", () => {
  test("le plan reste identique octet pour octet", () => {
    const plan = buildShowPlan(LEGACY_ANALYSIS, false);
    const text = stableStringify(plan);
    const digest = createHash("sha256").update(text).digest("hex");
    expect(digest).toBe("ec97039532acef9a67c00963536be560d552db4dd045e536c4ceb6b050e73791");
    expect(text).not.toContain("confidence");
  });
});
