/**
 * Sérialisation stable d'un plan de spectacle, pour les snapshots de non-régression.
 *
 * Le format est volontairement explicite : chaque scène garde les champs qui
 * décident du rendu (famille, variante, fond, humeur, rôle, teinte, intensité,
 * signature de drop) et la raison de la frontière. Les clés sont triées et les
 * flottants arrondis à 3 décimales : deux plans identiques produisent le même
 * octet, et un diff ne montre que les changements réels.
 *
 * Ce module ne modifie rien : il lit `buildShowPlan` et sérialise.
 */

import { buildShowPlan, type ShowPlan } from "../../src/core/show";
import type { Analysis } from "../../src/types";

/** Version du format de snapshot. À incrémenter si la forme change. */
export const SNAPSHOT_VERSION = 1;
/** Nombre de décimales conservées pour tous les flottants. */
export const SNAPSHOT_DECIMALS = 3;

export interface SnapshotDrop {
  barres: string;
  blinders: string;
  hue: string;
  lyres: string;
}

export interface SnapshotScene {
  start: number;
  end: number;
  reason: string;
  role: string;
  mood: string;
  family: string;
  variant: string;
  backdrop: string;
  hue: number;
  accent: number;
  intensity: number;
  fadeIn: number;
  fadeOut: number;
  saturation: number;
  lightness: number;
  drop: SnapshotDrop | null;
}

export interface SnapshotTrack {
  duration: number;
  seed: number;
  track: { name: string; hue: number; accent: number; spread: number };
  backdrop: string;
  barStarts: number[];
  scenes: SnapshotScene[];
}

export interface SnapshotFile {
  version: number;
  /** Clé : nom de piste. */
  tracks: Record<string, SnapshotTrack>;
}

export function roundTo(value: number, decimals = SNAPSHOT_DECIMALS): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  // `-0` et `0` sont le même nombre mais pas la même chaîne JSON.
  return rounded === 0 ? 0 : rounded;
}

/** Sérialise une valeur JSON avec des clés triées et des flottants arrondis. */
export function stableValue(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? roundTo(value) : null;
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = stableValue(source[key]);
    return out;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function serializeScene(scene: ShowPlan["scenes"][number]): SnapshotScene {
  return {
    start: scene.start,
    end: scene.end,
    reason: scene.reason,
    role: scene.role,
    mood: scene.mood,
    family: scene.family,
    variant: scene.variant,
    backdrop: scene.backdrop,
    hue: scene.palette.hue,
    accent: scene.palette.accent,
    intensity: scene.intensity,
    fadeIn: scene.fadeIn,
    fadeOut: scene.fadeOut,
    saturation: scene.palette.saturation,
    lightness: scene.palette.lightness,
    drop:
      scene.drop === undefined
        ? null
        : {
            barres: scene.drop.barres,
            blinders: scene.drop.blinders,
            hue: scene.drop.hue,
            lyres: scene.drop.lyres,
          },
  };
}

/**
 * Projection stable d'un plan complet.
 *
 * Les flottants sont arrondis ici, pas seulement à l'écriture : le snapshot en
 * mémoire est ainsi identique au fichier relu, et le diff ne voit pas de
 * « changement » de précision.
 */
export function serializePlan(plan: ShowPlan): SnapshotTrack {
  return stableValue({
    duration: plan.duration,
    seed: plan.seed,
    track: {
      name: plan.track.name,
      hue: plan.track.hue,
      accent: plan.track.accent,
      spread: plan.track.spread,
    },
    backdrop: plan.backdrop,
    barStarts: [...plan.barStarts],
    scenes: plan.scenes.map(serializeScene),
  }) as unknown as SnapshotTrack;
}

/**
 * Construit le snapshot de toutes les pistes, en mode normal **et** réduit.
 *
 * Le mode réduit est inclus parce qu'il emprunte d'autres branches de
 * `familyFor` : sans lui, une régression du mode confort passerait inaperçue.
 */
export function buildSnapshot(
  tracks: ReadonlyArray<{ name: string; analysis: Analysis }>,
): SnapshotFile {
  const out: Record<string, SnapshotTrack> = {};
  for (const track of tracks) {
    out[track.name] = serializePlan(buildShowPlan(track.analysis, false));
  }
  return { version: SNAPSHOT_VERSION, tracks: out };
}

export function buildReducedSnapshot(
  tracks: ReadonlyArray<{ name: string; analysis: Analysis }>,
): SnapshotFile {
  const out: Record<string, SnapshotTrack> = {};
  for (const track of tracks) {
    out[track.name] = serializePlan(buildShowPlan(track.analysis, true));
  }
  return { version: SNAPSHOT_VERSION, tracks: out };
}

/**
 * Diff lisible entre deux snapshots, piste par piste et scène par scène.
 *
 * Retourne une liste de lignes vides si les snapshots sont identiques.
 */
export function diffSnapshots(expected: SnapshotFile, actual: SnapshotFile): string[] {
  const lines: string[] = [];
  const names = [...new Set([...Object.keys(expected.tracks), ...Object.keys(actual.tracks)])].sort();
  for (const name of names) {
    const before = expected.tracks[name];
    const after = actual.tracks[name];
    if (before === undefined) {
      lines.push(`+ piste ajoutée : ${name}`);
      continue;
    }
    if (after === undefined) {
      lines.push(`- piste retirée : ${name}`);
      continue;
    }
    if (before.duration !== after.duration) {
      lines.push(`${name} : durée ${before.duration} → ${after.duration}`);
    }
    if (before.seed !== after.seed) lines.push(`${name} : graine ${before.seed} → ${after.seed}`);
    if (before.backdrop !== after.backdrop) {
      lines.push(`${name} : fond ${before.backdrop} → ${after.backdrop}`);
    }
    if (before.track.name !== after.track.name) {
      lines.push(`${name} : palette ${before.track.name} → ${after.track.name}`);
    }
    const count = Math.max(before.scenes.length, after.scenes.length);
    if (before.scenes.length !== after.scenes.length) {
      lines.push(`${name} : ${before.scenes.length} scènes → ${after.scenes.length} scènes`);
    }
    for (let index = 0; index < count; index += 1) {
      const a = before.scenes[index];
      const b = after.scenes[index];
      if (a === undefined) {
        lines.push(`${name} #${index} : scène ajoutée (${b?.start}→${b?.end})`);
        continue;
      }
      if (b === undefined) {
        lines.push(`${name} #${index} : scène retirée (${a.start}→${a.end})`);
        continue;
      }
      const changed: string[] = [];
      for (const key of Object.keys(a) as Array<keyof SnapshotScene>) {
        if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
          changed.push(`${key} ${JSON.stringify(a[key])} → ${JSON.stringify(b[key])}`);
        }
      }
      if (changed.length > 0) {
        lines.push(`${name} #${index} (${a.start}→${a.end}) : ${changed.join(", ")}`);
      }
    }
  }
  return lines;
}
