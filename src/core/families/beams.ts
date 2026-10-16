import { shiftHue } from "../color";
import type { BeamLayer, BeamSpec } from "./types";
import { BEAM_FINE_MAX } from "./types";
import { paint } from "./util";

/**
 * Profil d'un faisceau, de l'extérieur vers le cœur.
 *
 * Un projecteur dans une salle enfumée ne dessine pas un triangle net : la
 * lumière diffuse, donc le bord est flou et le centre dense. On empile pour ça
 * quelques couches de plus en plus étroites et de plus en plus lumineuses ; leur
 * somme donne une section de lumière fondue sur les bords.
 */
export function beamLayers(
  width: number,
  alpha: number,
  lightness: number,
  layers = 3,
  footRatio = 0.32,
): BeamLayer[] {
  const nombre = Math.max(1, Math.round(layers));
  if (nombre === 1) {
    return [{ halfWidth: width, footHalfWidth: width * footRatio, alpha, lightness }];
  }
  const out: BeamLayer[] = [];
  for (let index = 0; index < nombre; index += 1) {
    const t = index / (nombre - 1);
    out.push({
      halfWidth: width * (1 - 0.52 * t),
      footHalfWidth: width * footRatio * (1 - 0.6 * t),
      // L'enveloppe est à peine visible, le cœur porte la lumière : leur
      // superposition donne la décroissance douce d'un bord de faisceau.
      alpha: alpha * (0.26 + 0.62 * t),
      lightness: lightness + 0.1 * t,
    });
  }
  return out;
}

/**
 * Rayon de la passe de flou de la nappe large, en pixels.
 *
 * Une seule valeur pour tous les gros faisceaux de l'image : c'est justement ce
 * qui la rend abordable — une passe, quel que soit le nombre de projecteurs — et
 * c'est aussi plus juste, car dans une salle enfumée la diffusion est celle de
 * l'air, pas celle de la lampe.
 */
export function hazeRadiusPixels(width: number, height: number, quality: number): number {
  const part = quality >= 0.85 ? 0.011 : 0.008;
  return Math.min(Math.max(5, Math.min(width, height) * part), quality >= 0.85 ? 16 : 11);
}

/**
 * Rayon de la nappe fine, en pixels.
 *
 * Nettement plus court : il doit adoucir un trait sans l'effacer. C'est ce qui
 * laisse les colonnes de la pluie, les branches de l'étoile ou les rayons d'un
 * vortex se lire comme des traits de lumière, et non comme une tache.
 */
export function hazeFineRadiusPixels(width: number, height: number, quality: number): number {
  const part = quality >= 0.85 ? 0.0058 : 0.004;
  return Math.min(Math.max(2.5, Math.min(width, height) * part), quality >= 0.85 ? 8 : 6);
}

/**
 * Dessine un faisceau souple.
 *
 * L'adoucissement du bord passe par la surface de fumée : le faisceau y est
 * déposé, la surface est floutée une fois pour toute l'image, puis remontée. Le
 * flou est ainsi payé une seule fois, quel que soit le nombre de projecteurs
 * allumés — c'est ce qui permet de le garder partout, sur toutes les machines.
 *
 * Sans surface (mode réduit, ou navigateur sans toile), on retombe sur la
 * superposition de couches de plus en plus étroites, qui approche le même profil
 * sans dépendre d'un filtre.
 */
export function softBeam(ctx: CanvasRenderingContext2D, spec: BeamSpec): void {
  const { x, y, angle, length, width, hue, saturation, lightness, alpha } = spec;
  if (alpha <= 0.002 || width <= 0.2) return;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const px = -dy;
  const py = dx;
  const tailHue = spec.tailHue ?? shiftHue(hue, 18);
  const quality = spec.quality ?? 1;
  const reduced = spec.reduced ?? false;
  // Un trait serré va dans la nappe fine, un gros faisceau dans la nappe large :
  // c'est ce qui permet à la pluie de lumière de rester une pluie.
  const fumee = width > BEAM_FINE_MAX ? spec.fumee?.large : spec.fumee?.fine;
  const cible = fumee?.ctx ?? ctx;
  if (fumee !== undefined) fumee.used = true;

  const nombre = spec.layers ?? (fumee !== undefined ? 2 : beamLayerCount(quality, reduced));
  const couches = beamLayers(width, alpha, lightness, nombre, spec.footRatio ?? 0.32);

  for (const couche of couches) {
    const gradient = cible.createLinearGradient(x, y, x + dx * length, y + dy * length);
    gradient.addColorStop(0, paint(hue, saturation, couche.lightness + 0.06, couche.alpha));
    gradient.addColorStop(0.45, paint(hue, saturation, couche.lightness, couche.alpha * 0.55));
    gradient.addColorStop(1, paint(tailHue, saturation, couche.lightness, 0));
    cible.fillStyle = gradient;
    cible.beginPath();
    cible.moveTo(x + px * couche.footHalfWidth, y + py * couche.footHalfWidth);
    cible.lineTo(x + dx * length + px * couche.halfWidth, y + dy * length + py * couche.halfWidth);
    cible.lineTo(x + dx * length - px * couche.halfWidth, y + dy * length - py * couche.halfWidth);
    cible.lineTo(x - px * couche.footHalfWidth, y - py * couche.footHalfWidth);
    cible.closePath();
    cible.fill();
  }
}

/** Nombre de couches d'un faisceau selon la qualité : plus la machine souffle, plus le bord est travaillé. */
function beamLayerCount(quality: number, reduced: boolean): number {
  if (reduced) return 1;
  if (quality >= 0.85) return 3;
  if (quality >= 0.55) return 2;
  return 1;
}

/**
 * Faisceau courbe : le rayon s'enroule au lieu de filer droit.
 *
 * Des faisceaux droits partant tous du même point dessinent un éventail — jamais
 * une spirale. Pour qu'on lise un vortex, il faut que la lumière tourne. Le
 * tracé suit donc une courbe, épaissie en plusieurs passages de plus en plus
 * fins et de plus en plus clairs, comme `beamLayers` le fait pour un faisceau
 * droit.
 */
export function curvedBeam(ctx: CanvasRenderingContext2D, spec: BeamSpec & { courbure: number }): void {
  const { x, y, angle, length, width, hue, saturation, lightness, alpha, courbure } = spec;
  if (alpha <= 0.002 || width <= 0.2) return;
  const quality = spec.quality ?? 1;
  const reduced = spec.reduced ?? false;
  const fumee = width > BEAM_FINE_MAX ? spec.fumee?.large : spec.fumee?.fine;
  const cible = fumee?.ctx ?? ctx;
  if (fumee !== undefined) fumee.used = true;

  // Point de contrôle : à mi-course le rayon a déjà tourné de la moitié de son
  // enroulement, ce qui donne une spirale régulière plutôt qu'un coude.
  const fin = angle + courbure;
  const milieu = angle + courbure * 0.42;
  const demi = length * 0.62;
  const cx = x + Math.cos(milieu) * demi;
  const cy = y + Math.sin(milieu) * demi;
  const ex = x + Math.cos(fin) * length;
  const ey = y + Math.sin(fin) * length;

  const couches = beamLayerCount(quality, reduced);
  const ancien = { lineWidth: cible.lineWidth, lineCap: cible.lineCap, lineJoin: cible.lineJoin };
  cible.lineCap = "round";
  cible.lineJoin = "round";
  for (let i = 0; i < couches; i += 1) {
    const t = couches === 1 ? 1 : i / (couches - 1);
    const poids = 0.3 + 0.65 * t;
    const gradient = cible.createLinearGradient(x, y, ex, ey);
    gradient.addColorStop(0, paint(hue, saturation, lightness + 0.06 + 0.1 * t, alpha * poids));
    gradient.addColorStop(0.6, paint(hue, saturation, lightness + 0.1 * t, alpha * poids * 0.5));
    gradient.addColorStop(1, paint(shiftHue(hue, 18), saturation, lightness, 0));
    cible.strokeStyle = gradient;
    cible.lineWidth = width * 2 * (1 - 0.45 * t);
    cible.beginPath();
    cible.moveTo(x, y);
    cible.quadraticCurveTo(cx, cy, ex, ey);
    cible.stroke();
  }
  cible.lineWidth = ancien.lineWidth;
  cible.lineCap = ancien.lineCap;
  cible.lineJoin = ancien.lineJoin;
}
