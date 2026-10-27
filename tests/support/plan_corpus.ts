/**
 * Accès au corpus de mesure du plan de spectacle.
 *
 * Le corpus principal est celui de `tests/support/make_corpus.py` : six pistes
 * de 60 s analysées par le vrai serveur (60/90/128/170 BPM, une piste faible,
 * une piste « riche »). Les analyses sont mises en cache dans le répertoire du
 * corpus et ne sont régénérées que si `manifest.json` manque.
 *
 * Des morceaux réels peuvent être ajoutés explicitement avec
 * `NIGHTLIGHT_REAL_CORPUS` (liste de répertoires séparés par `:`). Ils ne font
 * jamais partie des snapshots versionnés : l'audio n'est pas dans le dépôt.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";

import type { Analysis } from "../../src/types";

const ROOT = resolve(import.meta.dir, "../..");
/** Répertoire par défaut du corpus de `make_corpus.py` (identique au diagnostic). */
export const DEFAULT_CORPUS_DIR = "/tmp/night-light-plan-corpus";
/** Cache des analyses de morceaux réels (audio hors dépôt). */
const REAL_CACHE_DIR = join(ROOT, "tests/fixtures/analyses");

export interface PlanTrack {
  name: string;
  analysis: Analysis;
  source: "corpus" | "real" | "fixture";
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} a échoué`);
}

/** Génère le corpus s'il n'est pas déjà analysé. */
export function ensureCorpus(directory = DEFAULT_CORPUS_DIR): string {
  const manifest = join(directory, "manifest.json");
  if (existsSync(manifest)) return directory;
  mkdirSync(directory, { recursive: true });
  run("uv", ["run", "python", "tests/support/make_corpus.py", directory]);
  return directory;
}

/** Charge les six analyses du corpus, dans l'ordre alphabétique des noms. */
export function loadCorpusAnalyses(directory = DEFAULT_CORPUS_DIR): PlanTrack[] {
  const root = ensureCorpus(directory);
  const files = readdirSync(root)
    .filter((file) => file.endsWith(".json") && file !== "manifest.json")
    .sort();
  return files.map((file) => ({
    name: basename(file, ".json"),
    analysis: JSON.parse(readFileSync(join(root, file), "utf8")) as Analysis,
    source: "corpus" as const,
  }));
}

/**
 * Analyse (et met en cache) des morceaux réels.
 *
 * `paths` est une liste de fichiers audio ou de répertoires. Le cache est
 * invalidé dès qu'un fichier est plus récent que lui.
 */
export function loadRealAnalyses(paths: ReadonlyArray<string>): PlanTrack[] {
  const files: string[] = [];
  for (const entry of paths) {
    const path = resolve(entry);
    if (!existsSync(path)) throw new Error(`morceau introuvable : ${path}`);
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (/\.(wav|mp3|flac|ogg|m4a|opus)$/i.test(name)) files.push(join(path, name));
      }
    } else {
      files.push(path);
    }
  }
  if (files.length === 0) return [];
  const key = createHash("sha1")
    .update(files.map((file) => `${file}:${statSync(file).mtimeMs}`).join("|"))
    .digest("hex")
    .slice(0, 12);
  const cache = join(REAL_CACHE_DIR, `real-${key}.json`);
  const newest = Math.max(...files.map((file) => statSync(file).mtimeMs));
  if (!existsSync(cache) || statSync(cache).mtimeMs < newest) {
    mkdirSync(REAL_CACHE_DIR, { recursive: true });
    const args = ["run", "python", "scripts/analyze_corpus.py"];
    for (const file of files) args.push("--track", file);
    args.push("--out", cache);
    run("uv", args);
  }
  const payload = JSON.parse(readFileSync(cache, "utf8")) as Array<{ name: string; analysis: Analysis }>;
  return payload.map((entry) => ({
    name: entry.name,
    analysis: entry.analysis,
    source: "real" as const,
  }));
}

/** Morceaux réels demandés par l'environnement, s'il y en a. */
export function realCorpusFromEnv(): PlanTrack[] {
  const raw = process.env.NIGHTLIGHT_REAL_CORPUS;
  if (raw === undefined || raw.trim() === "") return [];
  return loadRealAnalyses(raw.split(":").filter((entry) => entry.trim() !== ""));
}

export function trackExtension(name: string): string {
  return extname(name) || ".json";
}

// --- Corpus réel (manifeste versionné, audio et analyses hors git) ----------

export interface RealCorpusEntry {
  id: number;
  titre: string;
  artiste: string;
  profil: string;
  durée: number;
  /** Métrique musicalement correcte : 3 ou 4. */
  meter_attendu: 3 | 4;
}

export interface RealPlanTrack extends PlanTrack {
  id: number;
  titre: string;
  artiste: string;
  profile: string;
  expectedDuration: number;
  expectedMeter: 3 | 4;
}

export const REAL_MANIFEST = join(ROOT, "tests/support/real_corpus.json");
export const REAL_ANALYSIS_DIR = join(ROOT, "tests/fixtures/analyses");

/**
 * Charge les analyses du corpus réel décrit par `tests/support/real_corpus.json`.
 *
 * Les fichiers audio et d'analyse ne sont pas versionnés : lancer d'abord
 * `uv run python tools/real_corpus.py`. Une analyse manquante est une erreur
 * explicite, jamais un corpus silencieusement partiel.
 */
export function loadRealCorpus(
  manifestPath = REAL_MANIFEST,
  analysisDir = REAL_ANALYSIS_DIR,
): RealPlanTrack[] {
  if (!existsSync(manifestPath)) throw new Error(`manifeste réel absent : ${manifestPath}`);
  const entries = JSON.parse(readFileSync(manifestPath, "utf8")) as RealCorpusEntry[];
  const tracks: RealPlanTrack[] = [];
  for (const entry of entries) {
    const analysisPath = join(analysisDir, `real-${entry.id}.json`);
    if (!existsSync(analysisPath)) {
      throw new Error(
        `analyse réelle absente pour ${entry.titre} : ${analysisPath}\n` +
          "lancer : uv run python tools/real_corpus.py",
      );
    }
    tracks.push({
      name: entry.titre,
      analysis: JSON.parse(readFileSync(analysisPath, "utf8")) as Analysis,
      source: "real",
      id: entry.id,
      titre: entry.titre,
      artiste: entry.artiste,
      profile: entry.profil,
      expectedDuration: entry.durée,
      expectedMeter: entry.meter_attendu,
    });
  }
  return tracks;
}
