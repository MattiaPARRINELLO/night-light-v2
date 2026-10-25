/**
 * Le manifeste du corpus réel est versionné, mais ni l'audio ni les analyses ne
 * le sont. Ce test vérifie sa forme et sa couverture de profils sans réseau ni
 * fichiers lourds, pour qu'il reste utilisable par `tools/real_corpus.py`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Entry {
  id: number;
  titre: string;
  artiste: string;
  profil: string;
  durée: number;
}

const MANIFEST = join(import.meta.dir, "../support/real_corpus.json");
const entries = JSON.parse(readFileSync(MANIFEST, "utf8")) as Entry[];

describe("manifeste du corpus réel", () => {
  test("8 à 10 morceaux, champs exacts, identifiants uniques", () => {
    expect(entries.length).toBeGreaterThanOrEqual(8);
    expect(entries.length).toBeLessThanOrEqual(10);
    const ids = new Set(entries.map((entry) => entry.id));
    expect(ids.size).toBe(entries.length);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["artiste", "durée", "id", "profil", "titre"]);
      expect(Number.isInteger(entry.id)).toBe(true);
      expect(entry.id).toBeGreaterThan(0);
      expect(entry.titre.length).toBeGreaterThan(0);
      expect(entry.artiste.length).toBeGreaterThan(0);
      expect(entry.durée).toBeGreaterThan(0);
      expect(entry.profil.length).toBeGreaterThan(0);
    }
  });

  test("les profils demandés sont couverts", () => {
    const profiles = entries.map((entry) => entry.profil.toLowerCase()).join(" | ");
    for (const expected of [
      "rap",
      "acoustique",
      "électro",
      "house",
      "3/4",
      "longue intro",
      "dynamique",
      "pop",
    ]) {
      expect(profiles).toContain(expected);
    }
  });

  test("aucun chemin local ni secret dans le manifeste", () => {
    const raw = readFileSync(MANIFEST, "utf8");
    expect(raw).not.toMatch(/\/home\/|\/tmp\/|[A-Za-z]:\\/);
    expect(raw).not.toMatch(/arl|token|secret|password/i);
  });
});
