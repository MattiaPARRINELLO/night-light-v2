/**
 * Chorégraphie du stroboscope hard.
 *
 * Le profil hard n'est pas un strobe permanent : il alterne un mur de lumière
 * plein écran, un creux où seules les barres LED continuent, puis une reprise.
 * Ce cycle est partagé par le rendu de l'écran et par la bordure LED, pour que
 * les deux couches se répondent au lieu de clignoter chacune dans leur coin.
 */

import type { FrameState } from "./families/types";

export type HardStrobePhase = "plein" | "barres" | "reprise";

/** Longueur du cycle, en temps forts. */
export const HARD_STROBE_CYCLE_BEATS = 8;
/** Temps forts de plein strobe avant le creux. */
export const HARD_STROBE_FULL_BEATS = 4;
/** Temps forts de creux, où seule la bordure LED strobe. */
export const HARD_STROBE_BAR_BEATS = 2;

/**
 * Phase courante du cycle hard.
 *
 * `beatIndex` est fourni par la vue musicale : le cycle reste donc calé sur la
 * mesure et identique après une pause ou un seek.
 */
export function hardStrobePhase(f: FrameState): HardStrobePhase {
  const beat = Math.max(0, Math.floor(f.beatIndex));
  const local = beat % HARD_STROBE_CYCLE_BEATS;
  if (local < HARD_STROBE_FULL_BEATS) return "plein";
  if (local < HARD_STROBE_FULL_BEATS + HARD_STROBE_BAR_BEATS) return "barres";
  return "reprise";
}

/** Vrai quand le strobe plein écran a le droit de clignoter. */
export function hardStrobeAllowsFull(f: FrameState): boolean {
  return hardStrobePhase(f) !== "barres";
}

/** Vrai quand seules les barres LED doivent strober. */
export function hardStrobeBarsOnly(f: FrameState): boolean {
  return hardStrobePhase(f) === "barres";
}
