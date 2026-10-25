#!/usr/bin/env bun
/**
 * Snapshots des plans de spectacle sur le corpus de référence.
 *
 *   bun tools/plan-snapshots.ts --update   # écrit / met à jour les snapshots
 *   bun tools/plan-snapshots.ts --check    # vérifie sans écrire (défaut)
 *
 * La mise à jour est toujours explicite : aucun test ne régénère les fichiers.
 * Un changement de snapshot doit être justifié dans la revue (changement de
 * comportement voulu, catégorie de scènes concernée, mesure avant/après).
 */
import { mkdirSync, writeFileSync } from "node:fs";

import {
  compareSnapshot,
  SNAPSHOT_DIR,
  snapshotCorpus,
  snapshotFor,
  snapshotPath,
} from "../tests/support/plan_snapshot";

const args = process.argv.slice(2);
const update = args.includes("--update");
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage : bun tools/plan-snapshots.ts [--update|--check]");
  process.exit(0);
}

const tracks = snapshotCorpus();
if (update) mkdirSync(SNAPSHOT_DIR, { recursive: true });

let changed = 0;
for (const track of tracks) {
  const serialized = snapshotFor(track.analysis);
  if (update) {
    writeFileSync(snapshotPath(track.name), serialized, "utf8");
    console.log(`écrit ${snapshotPath(track.name)}`);
    continue;
  }
  const problem = compareSnapshot(track.name, serialized);
  if (problem !== null) {
    changed += 1;
    console.error(problem);
  } else {
    console.log(`ok    ${track.name}`);
  }
}

if (!update) {
  if (changed > 0) {
    console.error(`\n${changed}/${tracks.length} snapshot(s) divergent(s).`);
    process.exit(1);
  }
  console.log(`\n${tracks.length} snapshots conformes.`);
}
