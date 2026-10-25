import { describe, expect, test } from "bun:test";

import {
  compareSnapshot,
  snapshotCorpus,
  snapshotFor,
} from "../support/plan_snapshot";

/**
 * Snapshots de plans : la photo de référence du plan de spectacle sur le corpus.
 *
 * Un échec ici signifie qu'un changement a modifié le plan. Il est légitime —
 * mais il doit être justifié scène par scène (ou par catégorie) avant de lancer
 * `bun tools/plan-snapshots.ts --update`. Ne jamais mettre à jour en masse sans
 * explication.
 */
describe("snapshots de plans", () => {
  const tracks = snapshotCorpus();

  test("le corpus de référence contient les dix pistes attendues", () => {
    expect(tracks.length).toBe(10);
    expect(tracks.map((track) => track.name)).toEqual(
      [...tracks.map((track) => track.name)].sort(),
    );
  });

  for (const track of tracks) {
    test(`${track.name} : le plan est identique au snapshot`, () => {
      const actual = snapshotFor(track.analysis);
      const problem = compareSnapshot(track.name, actual);
      expect(problem).toBeNull();
    });
  }
});
