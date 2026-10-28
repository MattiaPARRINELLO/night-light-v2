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

/**
 * Analyse « version 4 » à plusieurs sections, dont une pause labellisée
 * `silence`. Le serveur v4 n'en produit qu'une, mais le contrat de
 * rétrocompatibilité doit tenir pour toute analyse sans champ V3.1 : la fusion
 * des frontières doit rester celle de la vague 2 (plancher de 5 s), pas le
 * plancher de 1,5 s réservé aux silences typés `kind: "silence"`.
 */
const LEGACY_MULTI_SECTION: Analysis = {
  schema: 2,
  duration: 96,
  tempo: 120,
  meter: 4,
  beatCount: 192,
  beatPeriod: 0.5,
  beats: Array.from({ length: 192 }, (_, index) => index * 0.5),
  onsets: Array.from({ length: 192 }, (_, index) => index * 0.5),
  energy: Array.from(
    { length: 96 },
    (_, index) => [index, index < 56 ? 0.7 : index < 58 ? 0.05 : 0.5] as [number, number],
  ),
  bass: Array.from({ length: 96 }, (_, index) => [index, 0.4] as [number, number]),
  mid: Array.from({ length: 96 }, (_, index) => [index, 0.5] as [number, number]),
  midLow: Array.from({ length: 96 }, (_, index) => [index, 0.5] as [number, number]),
  midHigh: Array.from({ length: 96 }, (_, index) => [index, 0.5] as [number, number]),
  high: Array.from({ length: 96 }, (_, index) => [index, 0.3] as [number, number]),
  sections: [
    { start: 0, end: 8, label: "calme", energy: 0.2, kind: "section", group: "", occurrence: 0 },
    { start: 8, end: 56, label: "intense", energy: 0.7, kind: "section", group: "", occurrence: 0 },
    { start: 56, end: 58, label: "silence", energy: 0.05, kind: "section", group: "", occurrence: 0 },
    { start: 58, end: 96, label: "descente", energy: 0.5, kind: "section", group: "", occurrence: 0 },
  ],
  builds: [],
};

describe("compatibilité analyse version 4", () => {
  test("le plan reste identique octet pour octet", () => {
    const plan = buildShowPlan(LEGACY_ANALYSIS, false);
    const text = stableStringify(plan);
    const digest = createHash("sha256").update(text).digest("hex");
    expect(digest).toBe("ec97039532acef9a67c00963536be560d552db4dd045e536c4ceb6b050e73791");
    expect(text).not.toContain("confidence");
  });

  test("une pause non typée V3.1 garde la fusion des frontières de la vague 2", () => {
    for (const [reduced, expected] of [
      [false, "529754b1c2573205d9227e2fa3b6252e5a737d728771dc4ed2bbd38cd4c8e83e"],
      [true, "0272fe78c201a5674458e29bff62cf931f9e04584aeb17d0120e97aaf793d63a"],
    ] as const) {
      const text = stableStringify(buildShowPlan(LEGACY_MULTI_SECTION, reduced));
      expect(createHash("sha256").update(text).digest("hex")).toBe(expected);
    }
  });
});
