#!/usr/bin/env bun
/**
 * Mesure de saturation pendant les drops, à 10 Hz.
 *
 *   bun tools/saturation-report.ts [--corpus <dir>] [--real <fichier|dir>]... [--out <json>]
 *
 * "Saturation" = part de pixels proches du blanc (luminance > 0,92 et
 * saturation < 0,15), mesurée sur une image réellement rendue par Chromium
 * headless. Chaque scène de rôle `drop` est échantillonnée toutes les 100 ms.
 *
 * Sortie texte lisible ; `--out` écrit aussi le JSON machine (échantillons
 * compris). Aucune écriture sans `--out`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_CORPUS_DIR, loadCorpusAnalyses, loadRealAnalyses } from "../tests/support/plan_corpus";
import { stats } from "../tests/support/plan_report";
import {
  aggregateSaturation,
  sampleDrops,
  type DropSaturation,
} from "../tests/support/drop_saturation";
import { createHeadlessRenderer } from "../tests/support/headless_render";
import { stableStringify } from "../tests/support/plan_snapshot";

function formatStats(value: ReturnType<typeof stats>): string {
  return `moy ${value.mean.toFixed(4)} · méd ${value.median.toFixed(4)} · p90 ${value.p90.toFixed(4)} · max ${value.max.toFixed(4)}`;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const corpusIndex = args.indexOf("--corpus");
  const corpus = corpusIndex >= 0 ? (args[corpusIndex + 1] ?? DEFAULT_CORPUS_DIR) : DEFAULT_CORPUS_DIR;
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const real: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--real" && args[index + 1] !== undefined) real.push(args[index + 1]!);
  }

  const tracks = loadCorpusAnalyses(corpus);
  if (real.length > 0) tracks.push(...loadRealAnalyses(real));

  const started = performance.now();
  const renderer = await createHeadlessRenderer();
  const measured: Array<{ track: string; source: string; drops: DropSaturation[] }> = [];
  try {
    for (const track of tracks) {
      const drops = await sampleDrops(renderer, track);
      measured.push({ track: track.name, source: track.source, drops });
    }
  } finally {
    await renderer.close();
  }
  const elapsed = (performance.now() - started) / 1000;
  const allDrops = measured.flatMap((entry) => entry.drops);
  const aggregate = aggregateSaturation(allDrops);

  console.log("=== Saturation des drops (part de pixels proches du blanc) ===");
  for (const entry of measured) {
    if (entry.drops.length === 0) {
      console.log(`${entry.track.padEnd(12)} aucun drop`);
      continue;
    }
    for (const drop of entry.drops) {
      console.log(
        `${entry.track.padEnd(12)} drop #${String(drop.window.index).padStart(2)} ` +
          `${drop.window.start.toFixed(2)}→${drop.window.end.toFixed(2)} ` +
          `${drop.window.family.padEnd(14)} n=${String(drop.ratios.length).padStart(3)} ` +
          formatStats(drop.stats),
      );
    }
  }
  console.log(
    `\nTotal : ${aggregate.drops} drops · ${aggregate.samples} échantillons · ` +
      formatStats(aggregate.stats),
  );
  console.log(`(${tracks.length} pistes, ${elapsed.toFixed(2)} s, échantillonnage 10 Hz)`);

  if (out !== undefined) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      stableStringify({
        method: {
          fps: 10,
          whiteLuminance: 0.92,
          whiteSaturation: 0.15,
          width: 320,
          height: 180,
        },
        tracks: measured,
        aggregate,
      }),
      "utf8",
    );
    console.log(`JSON machine : ${out}`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`saturation-report : ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
