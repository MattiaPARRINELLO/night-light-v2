#!/usr/bin/env bun
/**
 * Rapport de mesure du plan de spectacle sur tout le corpus.
 *
 * Usage :
 *   bun tools/plan-report.ts [--corpus <dir>] [--real <fichier|dir>]... [--json <fichier>]
 *   bun tools/plan-report.ts --diff <ancien.json> <nouveau.json>
 *
 * Sans `--json`, imprime un rapport texte lisible. `--json` écrit aussi la
 * version machine (clés triées, flottants arrondis à 3 décimales). `--diff`
 * compare deux rapports machine et n'analyse rien.
 *
 * Le corpus par défaut est celui de `tests/support/make_corpus.py`, généré au
 * premier lancement puis réutilisé. Les morceaux réels sont optionnels et
 * jamais inclus dans les snapshots versionnés.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  buildReport,
  diffReports,
  formatReport,
  type PlanMeasureReport,
} from "../tests/support/plan_report";
import { DEFAULT_CORPUS_DIR, loadCorpusAnalyses, loadRealAnalyses } from "../tests/support/plan_corpus";
import { stableStringify } from "../tests/support/plan_snapshot";

interface Options {
  corpus: string;
  real: string[];
  json?: string;
  diff: [string, string] | null;
}

export function parseArgs(argv: ReadonlyArray<string>): Options {
  const options: Options = { corpus: DEFAULT_CORPUS_DIR, real: [], diff: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--corpus") {
      options.corpus = argv[++index] ?? options.corpus;
    } else if (arg.startsWith("--corpus=")) {
      options.corpus = arg.slice("--corpus=".length);
    } else if (arg === "--real") {
      const value = argv[++index];
      if (value !== undefined) options.real.push(value);
    } else if (arg.startsWith("--real=")) {
      options.real.push(arg.slice("--real=".length));
    } else if (arg === "--json") {
      options.json = argv[++index];
    } else if (arg.startsWith("--json=")) {
      options.json = arg.slice("--json=".length);
    } else if (arg === "--diff") {
      const before = argv[++index];
      const after = argv[++index];
      if (before === undefined || after === undefined) {
        throw new Error("--diff attend deux fichiers : ancien.json nouveau.json");
      }
      options.diff = [before, after];
    } else if (arg.startsWith("--")) {
      throw new Error(`option inconnue : ${arg}`);
    } else {
      // Premier argument positionnel : répertoire de corpus.
      options.corpus = arg;
    }
  }
  return options;
}

function readReport(path: string): PlanMeasureReport {
  if (!existsSync(path)) throw new Error(`rapport introuvable : ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as PlanMeasureReport;
}

function writeJson(path: string, report: PlanMeasureReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableStringify(report), "utf8");
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));

  if (options.diff !== null) {
    const [beforePath, afterPath] = options.diff;
    const before = readReport(beforePath);
    const after = readReport(afterPath);
    console.log(`diff ${beforePath} → ${afterPath}`);
    console.log(diffReports(before, after).join("\n"));
    if (options.json !== undefined) {
      writeFileSync(
        options.json,
        `${JSON.stringify({ before: beforePath, after: afterPath, lines: diffReports(before, after) }, null, 2)}\n`,
        "utf8",
      );
    }
    return 0;
  }

  const started = performance.now();
  const tracks = loadCorpusAnalyses(options.corpus);
  if (options.real.length > 0) tracks.push(...loadRealAnalyses(options.real));
  if (tracks.length === 0) throw new Error("corpus vide");

  const report = buildReport(tracks);
  const elapsed = (performance.now() - started) / 1000;

  console.log(formatReport(report));
  console.log(`\n(${tracks.length} pistes, ${report.scenes.length} scènes, ${elapsed.toFixed(2)} s)`);
  if (options.json !== undefined) {
    writeJson(options.json, report);
    console.log(`JSON machine : ${options.json}`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`plan-report : ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
