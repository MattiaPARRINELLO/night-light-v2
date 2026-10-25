#!/usr/bin/env bun
/**
 * Vérifie ou met à jour les snapshots de plans du corpus.
 *
 *   bun tools/plan-snapshots.ts            # vérifie (code retour 1 si diff)
 *   bun tools/plan-snapshots.ts --update   # réécrit explicitement les snapshots
 *
 * La mise à jour n'est jamais automatique : le diff produit doit être relu et
 * justifié scène par scène (ou par catégorie) avant d'être committé.
 */

import { checkSnapshots, SNAPSHOT_DIR, writeSnapshots } from "../tests/support/plan_snapshot_store";
import { DEFAULT_CORPUS_DIR, loadCorpusAnalyses } from "../tests/support/plan_corpus";

function main(): number {
  const args = process.argv.slice(2);
  const update = args.includes("--update");
  const directoryIndex = args.indexOf("--corpus");
  const directory =
    directoryIndex >= 0 ? (args[directoryIndex + 1] ?? DEFAULT_CORPUS_DIR) : DEFAULT_CORPUS_DIR;

  const tracks = loadCorpusAnalyses(directory);
  if (tracks.length === 0) throw new Error("corpus vide");

  if (update) {
    const files = writeSnapshots(tracks);
    for (const file of files) console.log(`snapshot réécrit : ${file}`);
    console.log("Relire le diff et le justifier avant commit.");
    return 0;
  }

  const result = checkSnapshots(tracks);
  if (result.ok) {
    console.log(`snapshots à jour (${tracks.length} pistes, ${SNAPSHOT_DIR})`);
    return 0;
  }
  console.error("snapshots obsolètes :");
  console.error(result.lines.join("\n"));
  console.error("\nMise à jour explicite : bun tools/plan-snapshots.ts --update");
  return 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`plan-snapshots : ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
