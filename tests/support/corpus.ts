/**
 * Accès aux analyses RÉELLES du corpus de référence pour les tests de
 * propriété. Rien n'est fabriqué à la main : les analyses sortent de
 * `server.analysis.analyze_file`, exactement comme en production.
 *
 * Les résultats sont mis en cache dans `tests/fixtures/analyses/` (ignoré par
 * git) pour ne pas réanalyser à chaque exécution. Le cache est régénéré dès
 * qu'une piste du corpus est plus récente que lui.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Analysis } from "../../src/types";

const ROOT = resolve(import.meta.dir, "../..");
const CORPUS_DIR = join(ROOT, "tests/fixtures/corpus");
const CACHE_DIR = join(ROOT, "tests/fixtures/analyses");
const LONG_DIR = join(ROOT, "tests/fixtures/long");
const LONG_WAV = join(LONG_DIR, "j_long_3min.wav");
const LONG_CACHE = join(CACHE_DIR, "long-3min.json");

export interface TrackAnalysis {
  name: string;
  analysis: Analysis;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} a échoué`);
}

function newerThanCache(directory: string, cacheFile: string): boolean {
  if (!existsSync(cacheFile)) return true;
  const cacheTime = statSync(cacheFile).mtimeMs;
  return readdirSync(directory)
    .filter((name) => name.endsWith(".wav"))
    .some((name) => statSync(join(directory, name)).mtimeMs > cacheTime);
}

/** Les 10 analyses du corpus D1, dans l'ordre alphabétique des noms. */
export function corpusAnalyses(): TrackAnalysis[] {
  mkdirSync(CACHE_DIR, { recursive: true });
  const wavs = existsSync(CORPUS_DIR)
    ? readdirSync(CORPUS_DIR).filter((name) => name.endsWith(".wav"))
    : [];
  if (wavs.length < 10) {
    run("uv", ["run", "python", "tests/support/make_fixture.py", "corpus", CORPUS_DIR]);
  }
  const cache = join(CACHE_DIR, "corpus.json");
  if (newerThanCache(CORPUS_DIR, cache)) {
    run("uv", [
      "run",
      "python",
      "scripts/analyze_corpus.py",
      "--corpus",
      CORPUS_DIR,
      "--out",
      cache,
    ]);
  }
  return JSON.parse(readFileSync(cache, "utf8")) as TrackAnalysis[];
}

/**
 * Analyse réelle d'un morceau de 3 minutes (`write_rich_track`), pour les
 * propriétés de diversité qui n'ont pas de sens sur 30 s.
 */
export function longTrackAnalysis(): Analysis {
  mkdirSync(LONG_DIR, { recursive: true });
  if (!existsSync(LONG_WAV)) {
    run("uv", [
      "run",
      "python",
      "tests/support/make_fixture.py",
      LONG_WAV,
      "rich:180",
    ]);
  }
  if (newerThanCache(LONG_DIR, LONG_CACHE)) {
    run("uv", [
      "run",
      "python",
      "scripts/analyze_corpus.py",
      "--track",
      LONG_WAV,
      "--out",
      LONG_CACHE,
    ]);
  }
  const tracks = JSON.parse(readFileSync(LONG_CACHE, "utf8")) as TrackAnalysis[];
  const first = tracks[0];
  if (first === undefined) throw new Error("analyse longue absente");
  return first.analysis;
}
