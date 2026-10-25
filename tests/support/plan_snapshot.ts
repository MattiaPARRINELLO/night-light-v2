/**
 * Sérialisation stable du plan de spectacle, pour les snapshots de non-régression.
 *
 * Un snapshot ne contient que ce qui décrit le plan : aucun champ de rendu, aucune
 * valeur dépendant d'une horloge. Les flottants sont arrondis à trois décimales
 * et les clés triées, afin qu'une même analyse produise toujours les mêmes octets
 * (indépendamment de l'ordre d'insertion des propriétés).
 *
 * Mise à jour explicite, jamais automatique :
 *
 *   bun tools/plan-snapshots.ts --update
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildShowPlan, type DropSignature, type Scene, type ShowPlan } from "../../src/core/show";
import type { Analysis } from "../../src/types";
import { corpusAnalyses } from "./corpus";

/** Répertoire des snapshots versionnés (le corpus audio, lui, n'est pas versionné). */
export const SNAPSHOT_DIR = resolve(import.meta.dir, "../fixtures/plan-snapshots");

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export interface SceneSnapshot {
  backdrop: string;
  drop: DropSignature | null;
  end: number;
  family: string;
  hue: number;
  index: number;
  intensity: number;
  mood: string;
  reason: string;
  role: string;
  start: number;
  variant: string;
}

export interface PlanSnapshot {
  backdrop: string;
  coverage: [number, number] | null;
  duration: number;
  scenes: SceneSnapshot[];
  seed: number;
  track: { accent: number; hue: number; name: string; spread: number };
}

function sceneSnapshot(scene: Scene): SceneSnapshot {
  return {
    backdrop: scene.backdrop,
    drop: scene.drop ?? null,
    end: round3(scene.end),
    family: scene.family,
    hue: round3(scene.palette.hue),
    index: scene.index,
    intensity: round3(scene.intensity),
    mood: scene.mood,
    reason: scene.reason,
    role: scene.role,
    start: round3(scene.start),
    variant: scene.variant,
  };
}

/** Projection stable d'un plan complet. */
export function planSnapshot(plan: ShowPlan): PlanSnapshot {
  return {
    backdrop: plan.backdrop,
    coverage: plan.coverage === undefined ? null : [round3(plan.coverage[0]), round3(plan.coverage[1])],
    duration: round3(plan.duration),
    scenes: plan.scenes.map(sceneSnapshot),
    seed: round3(plan.seed),
    track: {
      accent: round3(plan.track.accent),
      hue: round3(plan.track.hue),
      name: plan.track.name,
      spread: round3(plan.track.spread),
    },
  };
}

/** Sérialisation à clés triées, deux espaces d'indentation, saut de ligne final. */
export function stableJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        out[key] = sort((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export function snapshotPath(name: string): string {
  return join(SNAPSHOT_DIR, `${name}.json`);
}

export function snapshotFor(analysis: Analysis, reduced = false): string {
  return stableJson(planSnapshot(buildShowPlan(analysis, reduced)));
}

/**
 * Corpus des snapshots : les dix pistes réelles du corpus de référence
 * (`tests/support/make_fixture.py`), analyses par le vrai serveur.
 */
export function snapshotCorpus(): Array<{ name: string; analysis: Analysis }> {
  return corpusAnalyses();
}

/**
 * Vérifie un snapshot. Retourne `null` si tout concorde, sinon un message
 * lisible indiquant la commande de mise à jour.
 */
export function compareSnapshot(name: string, actual: string): string | null {
  let expected: string;
  try {
    expected = readFileSync(snapshotPath(name), "utf8");
  } catch {
    return `snapshot absent : ${snapshotPath(name)}\n  générer avec : bun tools/plan-snapshots.ts --update`;
  }
  if (expected === actual) return null;

  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const length = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < length; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return (
        `snapshot différent : ${snapshotPath(name)}, ligne ${index + 1}\n` +
        `  attendu : ${expectedLines[index] ?? "<fin>"}\n` +
        `  obtenu  : ${actualLines[index] ?? "<fin>"}\n` +
        `  si le changement est voulu : bun tools/plan-snapshots.ts --update`
      );
    }
  }
  return `snapshot différent : ${snapshotPath(name)}`;
}
