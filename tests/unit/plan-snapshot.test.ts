/**
 * Snapshots de non-régression des plans de spectacle.
 *
 * Le corpus est celui de `tests/support/make_corpus.py` (six pistes analysées
 * par le vrai serveur). Le test compare le plan courant aux fichiers versionnés
 * de `tests/snapshots/plans/`. Il n'écrit jamais : la mise à jour passe par
 * `bun tools/plan-snapshots.ts --update`, explicitement.
 */

import { describe, expect, test } from "bun:test";

import { buildShowPlan } from "../../src/core/show";
import { loadContractFixtures } from "../support/contract_fixtures";
import { loadCorpusAnalyses } from "../support/plan_corpus";
import { buildReducedSnapshot, buildSnapshot, roundTo, stableStringify } from "../support/plan_snapshot";
import { checkContractSnapshots, checkSnapshots } from "../support/plan_snapshot_store";

describe("snapshots de plans", () => {
  test(
    "le plan courant égale le snapshot versionné (normal + réduit)",
    () => {
      const tracks = loadCorpusAnalyses();
      expect(tracks.length).toBe(6);
      const result = checkSnapshots(tracks);
      expect(result.lines).toEqual([]);
      expect(result.ok).toBe(true);
    },
    180_000,
  );

  test("le snapshot est stable d'une génération à l'autre", () => {
    const tracks = loadCorpusAnalyses();
    const first = stableStringify(buildSnapshot(tracks));
    const second = stableStringify(buildSnapshot(tracks));
    expect(first).toBe(second);
  });

  test("les clés sont triées et les flottants arrondis à 3 décimales", () => {
    const tracks = loadCorpusAnalyses();
    const snapshot = buildSnapshot(tracks);
    const text = stableStringify(snapshot);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);

    // Les clés d'un objet doivent être dans l'ordre lexicographique.
    const checkSorted = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) checkSorted(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const keys = Object.keys(value);
      expect(keys).toEqual([...keys].sort());
      for (const key of keys) checkSorted((value as Record<string, unknown>)[key]);
    };
    checkSorted(JSON.parse(text));

    // Aucun flottant ne doit porter plus de 3 décimales.
    const tooPrecise = (value: unknown): boolean => {
      if (typeof value === "number") return Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-6;
      if (Array.isArray(value)) return value.some(tooPrecise);
      if (value !== null && typeof value === "object") {
        return Object.values(value).some(tooPrecise);
      }
      return false;
    };
    expect(tooPrecise(JSON.parse(text))).toBe(false);
    expect(roundTo(1.23456)).toBe(1.235);
    expect(roundTo(-0.0001)).toBe(0);
  });

  test("le snapshot normal contient tous les champs de contrat d'une scène", () => {
    const tracks = loadCorpusAnalyses();
    const snapshot = buildSnapshot(tracks);
    const scenes = Object.values(snapshot.tracks).flatMap((track) => track.scenes);
    expect(scenes.length).toBeGreaterThan(0);
    for (const scene of scenes) {
      for (const key of [
        "start",
        "end",
        "reason",
        "role",
        "mood",
        "family",
        "variant",
        "backdrop",
        "hue",
        "intensity",
        "drop",
      ] as const) {
        expect(scene).toHaveProperty(key);
      }
      // La signature de drop n'existe que sur les scènes d'impact.
      if (scene.role === "drop") expect(scene.drop).not.toBeNull();
      else expect(scene.drop).toBeNull();
    }
  });

  test("le mode réduit produit un snapshot distinct et déterministe", () => {
    const tracks = loadCorpusAnalyses();
    const normal = stableStringify(buildSnapshot(tracks));
    const reduced = stableStringify(buildReducedSnapshot(tracks));
    expect(reduced).toBe(stableStringify(buildReducedSnapshot(tracks)));
    expect(reduced).not.toBe(normal);
  });

  test("buildShowPlan est pur : deux appels donnent le même plan", () => {
    const tracks = loadCorpusAnalyses();
    const track = tracks[0]!;
    const first = stableStringify(buildShowPlan(track.analysis, false));
    const second = stableStringify(buildShowPlan(track.analysis, false));
    expect(first).toBe(second);
  });

  test("les fixtures v3.1 égales à leur snapshot versionné (normal + réduit)", () => {
    const fixtures = loadContractFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    const result = checkContractSnapshots(fixtures);
    expect(result.lines).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("le snapshot des fixtures v3.1 est stable d'une génération à l'autre", () => {
    const fixtures = loadContractFixtures();
    expect(stableStringify(buildSnapshot(fixtures))).toBe(stableStringify(buildSnapshot(fixtures)));
    expect(stableStringify(buildReducedSnapshot(fixtures))).toBe(
      stableStringify(buildReducedSnapshot(fixtures)),
    );
  });

  test("une analyse sans les champs v3.1 garde le comportement historique", () => {
    // Rétrocompatibilité du contrat v3.1 : retirer kind/group/confidence/
    // events/meterConfidence rend la dramaturgie dormante. Le plan est alors
    // strictement celui du code historique (même plan à chaque appel, et
    // identique à un appel explicitement non dramaturgique).
    const fixtures = loadContractFixtures();
    for (const fixture of fixtures) {
      const historique: typeof fixture.analysis = {
        ...fixture.analysis,
        sections: fixture.analysis.sections.map((section) => ({
          start: section.start,
          end: section.end,
          label: section.label,
          energy: section.energy,
        })),
        builds: fixture.analysis.builds,
      };
      delete (historique as { events?: unknown }).events;
      delete (historique as { meterConfidence?: unknown }).meterConfidence;
      const premier = stableStringify(buildShowPlan(historique, false));
      const second = stableStringify(buildShowPlan(historique, false));
      expect(second, `${fixture.name} : plan historique non déterministe`).toBe(premier);
      expect(stableStringify(buildShowPlan(historique, false, undefined, { dramaturgy: false }))).toBe(
        premier,
      );
      // Les champs v3.1, eux, réveillent bien des branches différentes.
      expect(stableStringify(buildShowPlan(fixture.analysis, false))).not.toBe(premier);
    }
  });
});
