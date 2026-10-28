/**
 * Stockage et vérification des snapshots de plans.
 *
 * Les snapshots sont versionnés ; ils ne sont **jamais** réécrits
 * automatiquement par les tests. La mise à jour est une commande explicite :
 *
 *   bun tools/plan-snapshots.ts --update
 *
 * puis le diff doit être relu et justifié.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { PlanTrack } from "./plan_corpus";
import {
  buildReducedSnapshot,
  buildSnapshot,
  diffSnapshots,
  stableStringify,
  type SnapshotFile,
} from "./plan_snapshot";

const ROOT = resolve(import.meta.dir, "../..");
export const SNAPSHOT_DIR = join(ROOT, "tests/snapshots/plans");

export interface SnapshotPaths {
  normal: string;
  reduced: string;
}

export interface SnapshotCheck {
  ok: boolean;
  lines: string[];
}

function paths(directory: string): SnapshotPaths {
  return {
    normal: join(directory, "corpus.json"),
    reduced: join(directory, "corpus-reduced.json"),
  };
}

function contractPaths(directory: string): SnapshotPaths {
  return {
    normal: join(directory, "contract_v3.json"),
    reduced: join(directory, "contract_v3-reduced.json"),
  };
}

function read(path: string): SnapshotFile | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as SnapshotFile;
}

function compareOne(path: string, actual: SnapshotFile): string[] {
  const stored = read(path);
  if (stored === null) return [`snapshot absent : ${path} (lancer --update explicitement)`];
  const diff = diffSnapshots(stored, actual);
  if (diff.length === 0) return [];
  return [`${path} :`, ...diff.map((line) => `  ${line}`)];
}

/** Compare les plans courants aux snapshots sans rien écrire. */
export function checkSnapshots(
  tracks: ReadonlyArray<PlanTrack>,
  directory = SNAPSHOT_DIR,
): SnapshotCheck {
  const files = paths(directory);
  const lines = [
    ...compareOne(files.normal, buildSnapshot(tracks)),
    ...compareOne(files.reduced, buildReducedSnapshot(tracks)),
  ];
  return { ok: lines.length === 0, lines };
}

/** Réécrit les snapshots. À n'appeler que sur demande explicite. */
export function writeSnapshots(
  tracks: ReadonlyArray<PlanTrack>,
  directory = SNAPSHOT_DIR,
): string[] {
  const files = paths(directory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(files.normal, stableStringify(buildSnapshot(tracks)), "utf8");
  writeFileSync(files.reduced, stableStringify(buildReducedSnapshot(tracks)), "utf8");
  return [files.normal, files.reduced];
}

/** Compare les plans des fixtures v3.1 à leurs snapshots versionnés. */
export function checkContractSnapshots(
  tracks: ReadonlyArray<PlanTrack>,
  directory = SNAPSHOT_DIR,
): SnapshotCheck {
  const files = contractPaths(directory);
  const lines = [
    ...compareOne(files.normal, buildSnapshot(tracks)),
    ...compareOne(files.reduced, buildReducedSnapshot(tracks)),
  ];
  return { ok: lines.length === 0, lines };
}

/** Réécrit les snapshots des fixtures. Commande explicite uniquement. */
export function writeContractSnapshots(
  tracks: ReadonlyArray<PlanTrack>,
  directory = SNAPSHOT_DIR,
): string[] {
  const files = contractPaths(directory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(files.normal, stableStringify(buildSnapshot(tracks)), "utf8");
  writeFileSync(files.reduced, stableStringify(buildReducedSnapshot(tracks)), "utf8");
  return [files.normal, files.reduced];
}
