import type { FamilyId } from "../show";
import type { TrackView } from "../view";
import { AMBIENT_FAMILIES } from "./ambient";
import { CONCERT_FAMILIES } from "./concert-rig";
import { CONCERT_LIGHT_FAMILIES } from "./concert-lights";
import { FIGURE_FAMILIES } from "./figures";
import { PROJECTOR_FAMILIES } from "./projectors";
import { RIDEAU_FAMILIES } from "./rideaux";
import { SHAPE_FAMILIES } from "./shapes";
import type { FamilyDraw, FrameState } from "./types";

export type { BeamLayer, BeamSpec, FamilyDraw, FrameState, HazeLayer, HazeTarget } from "./types";
export { BEAM_FINE_MAX, GRAND_BALAYAGE_BEATS, PETIT_ELEMENT_BEATS } from "./types";

export { beamLayers, curvedBeam, hazeFineRadiusPixels, hazeRadiusPixels, softBeam } from "./beams";
export { CONCERT_FAMILIES } from "./concert-rig";
export {
  blinderBordure,
  couleurBordure,
  dessinerBordure,
  intensiteBordure,
  motifBordure,
  moyenneBordure,
  NOMBRE_DIODES_BORDURE,
  poidsMotif,
  positionBordure,
  teinteBordure,
} from "./bordure";
export type { DiodeBordure, MotifBordure } from "./bordure";
export { contrastHue, lampHue, sceneChord } from "./harmony";
export { beatSwing, colorFlip, elementEnvelope, elementEnvelopeForEnergy } from "./tempo";
export { rowPositions } from "./geometry";
export { lyreWavePhase } from "./figures";
export { drawCoreGlow, drawWash } from "./projectors";
export {
  angleBatten,
  couleurBlinder,
  decroissanceFilament,
  dessinerBlinders,
  dessinerLyresRave,
  dessinerStructure,
  intensiteBlinder,
  motifBlinder,
  NOMBRE_BATTENS,
  NOMBRE_BLINDERS,
  NOMBRE_LYRES,
  orientationLyre,
  poidsBlinder,
  positionBatten,
  positionBlinder,
  positionLyre,
  TAU_FILAMENT,
  tempsTempsFort,
} from "./concert-rig";
export type { CouleurFilament, GesteLyre, MotifBlinder, OrientationLyre, PointScene } from "./concert-rig";

/**
 * Familles rangées par provenance.
 *
 * Ce découpage est la source unique de l'inventaire des effets : le studio
 * (`core/effects.ts`) le lit pour découvrir les familles, sans liste recopiée.
 * Ajouter une famille dans l'un de ces modules la fait apparaître partout.
 */
export const FAMILY_GROUPS = {
  ambiance: AMBIENT_FAMILIES,
  projecteurs: PROJECTOR_FAMILIES,
  rideaux: RIDEAU_FAMILIES,
  formes: SHAPE_FAMILIES,
  figures: FIGURE_FAMILIES,
  concert: CONCERT_FAMILIES,
  "concert-lumieres": CONCERT_LIGHT_FAMILIES,
} as const;

export const FAMILIES: Record<FamilyId, FamilyDraw> = {
  ...FAMILY_GROUPS.ambiance,
  ...FAMILY_GROUPS.projecteurs,
  ...FAMILY_GROUPS.rideaux,
  ...FAMILY_GROUPS.formes,
  ...FAMILY_GROUPS.figures,
  ...FAMILY_GROUPS.concert,
  ...FAMILY_GROUPS["concert-lumieres"],
};

export function drawFamily(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
  family: FamilyId,
): void {
  FAMILIES[family](ctx, f, view);
}
