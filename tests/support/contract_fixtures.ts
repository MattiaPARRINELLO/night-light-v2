/**
 * Fixtures synthétiques du contrat d'analyse v3.1.
 *
 * Elles vivent dans `tests/fixtures/contract_v3/` et sont générées par
 * `tests/support/make_contract_fixtures.ts`. Ce module les charge et vérifie
 * les invariants du contrat, sans toucher aux analyses réelles.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { Analysis } from "../../src/types";
import type { PlanTrack } from "./plan_corpus";

const ROOT = resolve(import.meta.dir, "../..");
export const CONTRACT_FIXTURE_DIR = join(ROOT, "tests/fixtures/contract_v3");

/** Tolérance de couverture entre deux sections (secondes). */
export const SECTION_EPSILON = 1e-6;
/** Durée minimale d'une section ordinaire (contrat v3.1). */
export const MIN_SECTION_SPAN = 4;
/** Durée minimale d'une section de silence (contrat v3.1). */
export const MIN_SILENCE_SECTION_SPAN = 1.5;
/** Espacement minimal entre deux bass-return (contrat v3.1). */
export const MIN_BASS_RETURN_SPACING = 8;
/** Distance minimale entre un bass-return et une fin de montée (contrat v3.1). */
export const BASS_RETURN_BUILD_CLEARANCE = 2;

export interface ContractFixture extends PlanTrack {
  source: "fixture";
  description: string;
}

function readManifest(directory: string): Map<string, string> {
  const path = join(directory, "manifest.json");
  if (!existsSync(path)) return new Map();
  const payload = JSON.parse(readFileSync(path, "utf8")) as {
    fixtures?: Array<{ name: string; description?: string }>;
  };
  return new Map((payload.fixtures ?? []).map((entry) => [entry.name, entry.description ?? ""]));
}

/** Charge toutes les fixtures, dans l'ordre alphabétique des noms. */
export function loadContractFixtures(directory = CONTRACT_FIXTURE_DIR): ContractFixture[] {
  if (!existsSync(directory)) return [];
  const descriptions = readManifest(directory);
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json") && file !== "manifest.json")
    .sort()
    .map((file) => {
      const name = basename(file, ".json");
      return {
        name,
        analysis: JSON.parse(readFileSync(join(directory, file), "utf8")) as Analysis,
        source: "fixture" as const,
        description: descriptions.get(name) ?? "",
      };
    });
}

export interface ContractViolation {
  fixture: string;
  rule: string;
  detail: string;
}

/**
 * Vérifie les invariants du contrat v3.1 sur une analyse.
 *
 * Ne juge pas la qualité musicale : uniquement la forme (couverture, durées,
 * intro/outro uniques, events espacés, confiances bornées).
 */
export function contractViolations(name: string, analysis: Analysis): ContractViolation[] {
  const out: ContractViolation[] = [];
  const add = (rule: string, detail: string) => out.push({ fixture: name, rule, detail });
  const duration = analysis.duration;

  if (analysis.meter !== 3 && analysis.meter !== 4) {
    add("meter", `meter doit rester 3 ou 4 (reçu ${String(analysis.meter)})`);
  }
  if (
    analysis.meterConfidence !== undefined &&
    (analysis.meterConfidence < 0 || analysis.meterConfidence > 1 || !Number.isFinite(analysis.meterConfidence))
  ) {
    add("meterConfidence", `hors [0,1] : ${String(analysis.meterConfidence)}`);
  }

  const sections = analysis.sections;
  if (sections.length === 0) add("sections", "aucune section");
  let previousEnd = 0;
  sections.forEach((section, index) => {
    if (section.start > previousEnd + SECTION_EPSILON) {
      add("couverture", `trou entre ${previousEnd} et ${section.start}`);
    }
    if (section.start < previousEnd - SECTION_EPSILON) {
      add("chevauchement", `section #${index} commence à ${section.start} avant ${previousEnd}`);
    }
    const span = section.end - section.start;
    const silence = section.kind === "silence" || section.label === "silence";
    const minimum = silence ? MIN_SILENCE_SECTION_SPAN : MIN_SECTION_SPAN;
    if (span < minimum - SECTION_EPSILON) {
      add("durée", `section #${index} (${section.kind ?? section.label}) dure ${span.toFixed(3)} s < ${minimum}`);
    }
    if (section.confidence !== undefined && (section.confidence < 0 || section.confidence > 1)) {
      add("confidence", `section #${index} hors [0,1] : ${section.confidence}`);
    }
    previousEnd = section.end;
  });
  if (Math.abs(previousEnd - duration) > SECTION_EPSILON) {
    add("couverture", `la dernière section finit à ${previousEnd}, durée ${duration}`);
  }

  const intros = sections.filter((section) => section.kind === "intro").length;
  const outros = sections.filter((section) => section.kind === "outro").length;
  if (intros > 1) add("intro", `${intros} sections intro`);
  if (outros > 1) add("outro", `${outros} sections outro`);
  if (intros === 1 && sections[0]?.kind !== "intro") add("intro", "l'intro n'est pas en tête");
  if (outros === 1 && sections[sections.length - 1]?.kind !== "outro") add("outro", "l'outro n'est pas en fin");

  const buildEnds = analysis.builds.map((build) => build.end);
  let previousReturn: number | undefined;
  for (const event of analysis.events ?? []) {
    if (event.kind !== "bass-return") add("events", `kind inconnu : ${String(event.kind)}`);
    if (event.strength < 0 || event.strength > 1 || !Number.isFinite(event.strength)) {
      add("events", `force hors [0,1] : ${event.strength}`);
    }
    if (previousReturn !== undefined && event.t - previousReturn < MIN_BASS_RETURN_SPACING) {
      add("bass-return", `espacement ${(event.t - previousReturn).toFixed(2)} s < ${MIN_BASS_RETURN_SPACING}`);
    }
    for (const end of buildEnds) {
      if (Math.abs(event.t - end) < BASS_RETURN_BUILD_CLEARANCE) {
        add("bass-return", `à ${Math.abs(event.t - end).toFixed(2)} s d'une fin de montée (${event.t})`);
      }
    }
    previousReturn = event.t;
  }

  return out;
}

/** Vérifie toutes les fixtures et retourne les violations. */
export function allContractViolations(fixtures = loadContractFixtures()): ContractViolation[] {
  return fixtures.flatMap((fixture) => contractViolations(fixture.name, fixture.analysis));
}
