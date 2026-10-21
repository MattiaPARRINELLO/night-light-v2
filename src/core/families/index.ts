import type { FamilyId } from "../show";
import type { TrackView } from "../view";
import { AMBIENT_FAMILIES } from "./ambient";
import { CONCERT_FAMILIES } from "./concert-rig";
import { FIGURE_FAMILIES } from "./figures";
import { PROJECTOR_FAMILIES } from "./projectors";
import { RIDEAU_FAMILIES } from "./rideaux";
import { SHAPE_FAMILIES } from "./shapes";
import type { FamilyDraw, FrameState } from "./types";

export type { BeamLayer, BeamSpec, FamilyDraw, FrameState, HazeLayer, HazeTarget } from "./types";
export { BEAM_FINE_MAX, GRAND_BALAYAGE_BEATS, PETIT_ELEMENT_BEATS } from "./types";

export { beamLayers, curvedBeam, hazeFineRadiusPixels, hazeRadiusPixels, softBeam } from "./beams";
export { contrastHue, lampHue, sceneChord } from "./harmony";
export { beatSwing, colorFlip, elementEnvelope } from "./tempo";
export { rowPositions } from "./geometry";
export { lyreWavePhase } from "./figures";
export { drawCoreGlow, drawWash } from "./projectors";
export {
  angleBatten,
  couleurBlinder,
  decroissanceFilament,
  dessinerBlinders,
  dessinerStructure,
  intensiteBlinder,
  NOMBRE_BATTENS,
  NOMBRE_BLINDERS,
  NOMBRE_LYRES,
  orientationLyre,
  positionBatten,
  positionBlinder,
  positionLyre,
  TAU_FILAMENT,
  tempsTempsFort,
} from "./concert-rig";
export type { CouleurFilament, OrientationLyre, PointScene } from "./concert-rig";

const FAMILIES: Record<FamilyId, FamilyDraw> = {
  ...AMBIENT_FAMILIES,
  ...PROJECTOR_FAMILIES,
  ...RIDEAU_FAMILIES,
  ...SHAPE_FAMILIES,
  ...FIGURE_FAMILIES,
  ...CONCERT_FAMILIES,
};

export function drawFamily(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
  family: FamilyId,
): void {
  FAMILIES[family](ctx, f, view);
}
