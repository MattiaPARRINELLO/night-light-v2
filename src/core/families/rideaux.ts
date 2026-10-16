import { clamp01 } from "../series";
import { shiftHue } from "../color";
import { lampHue } from "./harmony";
import { elementEnvelope } from "./tempo";
import { BEAM_FINE_MAX, type FamilyDraw, type HazeTarget } from "./types";
import { count, paint } from "./util";

/**
 * Petite scène en perspective pour la famille « double rideau ».
 *
 * Toutes les autres familles sont franchement 2D : un faisceau y est un trapèze
 * posé dans le plan de l'écran, et sa largeur ne dépend que du temps. Ici on
 * pose de vraies coordonnées (x, y, z), une caméra et une projection, parce que
 * c'est le seul moyen d'obtenir le raccourci qui fait « venir vers nous » : un
 * faisceau qui s'approche de la caméra s'écrase et s'élargit — un trapèze 2D ne
 * peut pas l'imiter. Le coût reste minuscule : trente faisceaux, quatre sommets
 * chacun, projetés à la main.
 */
interface Camera {
  /** Position de la caméra sur l'axe de profondeur (négatif = côté spectateur). */
  z: number;
  /** Distance focale, en pixels. */
  focal: number;
  cx: number;
  cy: number;
}

/** Point du monde : x vers la droite, y vers le haut, z vers le fond. */
interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Point projeté : coordonnées écran, plus la profondeur pour le tri. */
interface Ecran {
  x: number;
  y: number;
  depth: number;
}

/**
 * Projette un point du monde sur l'écran.
 *
 * Renvoie `null` derrière la caméra : un faisceau qui la dépasse ne doit pas se
 * retourner à l'écran, ce qui arrive si l'on divise par une profondeur négative.
 */
function projette(cam: Camera, p: Point3): Ecran | null {
  const depth = p.z - cam.z;
  if (depth <= 0.05) return null;
  return {
    x: cam.cx + (p.x / depth) * cam.focal,
    y: cam.cy - (p.y / depth) * cam.focal,
    depth,
  };
}

/**
 * Point du monde qui se projette pile sur `(xe, ye)`, à la profondeur `depth`.
 *
 * L'inverse de `projette`. Il sert à composer : on choisit où le bout du
 * faisceau doit tomber dans le cadre — c'est un choix de mise en scène — et on
 * laisse la géométrie placer le point dans la salle. Le bout approchant de la
 * caméra, sa largeur à l'écran, elle, échappe au contrôle : c'est la perspective
 * qui décide, et c'est exactement ce qu'on veut d'un faisceau qui vient à nous.
 */
function cibleEcran(cam: Camera, xe: number, ye: number, depth: number): Point3 {
  return {
    x: ((xe - cam.cx) * depth) / cam.focal,
    y: (-(ye - cam.cy) * depth) / cam.focal,
    z: cam.z + depth,
  };
}

/** Un faisceau du rideau, avant projection. */
interface Faisceau {
  origine: Point3;
  cible: Point3;
  /** Demi-largeur du monde au pied, et au bout. */
  demiLargeur: number;
  demiLargeurFin: number;
  hue: number;
  saturation: number;
  lightness: number;
  alpha: number;
  /** Profondeur de l'origine : sert au tri de recouvrement. */
  zTri: number;
}

/**
 * Dessine un faisceau projeté.
 *
 * La largeur à l'écran est `largeur / profondeur × focale` : c'est la
 * perspective elle-même qui écarte le faisceau quand il approche, sans qu'on
 * ait à la simuler. Le trapèze suit la perpendiculaire écran du faisceau, donc
 * il reste d'épaisseur régulière même quand le faisceau plonge vers le coin de
 * l'écran.
 */
function dessineFaisceau(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  faisceau: Faisceau,
  fumee: HazeTarget | undefined,
): void {
  const a = projette(cam, faisceau.origine);
  const b = projette(cam, faisceau.cible);
  if (a === null || b === null) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const longueur = Math.hypot(dx, dy);
  if (longueur < 1) return;

  const px = -dy / longueur;
  const py = dx / longueur;
  const ha = (faisceau.demiLargeur / a.depth) * cam.focal;
  const hb = (faisceau.demiLargeurFin / b.depth) * cam.focal;
  if (ha <= 0.05 && hb <= 0.05) return;

  // Comme les autres familles : un trait serré dans la nappe fine, un gros
  // faisceau dans la nappe large. Une seule nappe est floutée par image, quel
  // que soit le nombre de projecteurs.
  const couche = (Math.max(ha, hb) > BEAM_FINE_MAX ? fumee?.large : fumee?.fine) ?? undefined;
  if (couche !== undefined) couche.used = true;
  const cible = couche?.ctx ?? ctx;

  const gradient = cible.createLinearGradient(a.x, a.y, b.x, b.y);
  const { hue, saturation, lightness, alpha } = faisceau;
  gradient.addColorStop(0, paint(hue, saturation, lightness + 0.06, alpha));
  gradient.addColorStop(0.55, paint(hue, saturation, lightness, alpha * 0.5));
  gradient.addColorStop(1, paint(shiftHue(hue, 20), saturation, lightness, 0));
  cible.fillStyle = gradient;
  cible.beginPath();
  cible.moveTo(a.x + px * ha, a.y + py * ha);
  cible.lineTo(b.x + px * hb, b.y + py * hb);
  cible.lineTo(b.x - px * hb, b.y - py * hb);
  cible.lineTo(a.x - px * ha, a.y - py * ha);
  cible.closePath();
  cible.fill();
}

/** Recul de la caméra devant la scène, en unités du monde. */
const CAMERA_Z = 3.4;
/** Demi-largeur du cadre au niveau de la scène, en unités. */
const DEMI_LARGEUR = 2.1;
/** Largeur d'une rangée, en fraction de la largeur d'écran : elle déborde des deux bords. */
const RANGEE_LARGEUR = 1.18;
/** Profondeur de l'arc d'une rangée : ses extrémités reculent dans la salle. */
const ARC_PROFONDEUR = 0.9;
/** Profondeur du bout des faisceaux : petit = tout près de la caméra. */
const PROFONDEUR_FIN = 0.95;
/** Ouverture ajoutée à cette profondeur : ouvert, le faisceau vient moins près. */
const PROFONDEUR_FIN_OUVERTE = 0.55;

/**
 * Double rideau : deux rangées symétriques de quinze projecteurs, l'une au
 * plafond, l'autre au plancher, qui se font face puis s'ouvrent vers nous.
 *
 * C'est la seule famille qui travaille en profondeur. Les deux rangées longent
 * le bord haut et le bord bas de l'écran, comme un portique de salle. Fermés,
 * les deux rideaux croisent leurs faisceaux : chaque lampe du plafond descend
 * jusqu'au bord opposé, celle du plancher monte jusqu'en haut — un mur de
 * lumière tissé qui ferme toute la salle. Quand la musique monte, les deux
 * rideaux s'écartent : chaque faisceau balaie du bord opposé vers le sien,
 * jusqu'à sortir du cadre, et le couloir central s'ouvre sur le fond.
 *
 * Le bout de chaque faisceau est posé **tout près de la caméra** : il arrive
 * donc sur nous en s'écrasant et en s'élargissant, ce qu'aucun trapèze 2D ne
 * sait imiter. Les extrémités des rangées reculent en plus dans la salle, donc
 * les lampes des bords sont plus petites et passent derrière celles du centre.
 *
 * Chaque lampe s'allume et s'éteint à son tour (`elementEnvelope`), donc le
 * rideau respire au lieu de clignoter d'un bloc — même principe que le rideau
 * de lumière, mais dans l'espace.
 */
const rideaux: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const parRangee = count(15, f.quality, f.reduced);
  if (parRangee < 1) return;

  const cam: Camera = {
    z: -CAMERA_Z,
    // La focale est choisie pour qu'à la distance de la scène, la largeur
    // visible vaille `DEMI_LARGEUR` unités de part et d'autre du centre.
    focal: ((w * 0.5) * CAMERA_Z) / DEMI_LARGEUR,
    cx: w * 0.5,
    cy: h * 0.5,
  };

  // Ouverture : 0 = rideaux croisés qui ferment la salle, 1 = grands rideaux
  // écartés jusqu'aux bords. Elle suit l'énergie, donc un impact ouvre d'un coup.
  const ouverture = f.reduced ? 0.4 : clamp01(0.1 + 0.62 * f.energy + 0.3 * f.beat);
  const alpha = (0.06 + 0.3 * f.energy + 0.16 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  const cycle = f.reduced ? 26 : f.energy > 0.55 ? 12 : 20;
  const masse = 0.05 * (0.8 + 0.5 * f.energy);
  const profondeurFin = PROFONDEUR_FIN + PROFONDEUR_FIN_OUVERTE * ouverture;
  const faisceaux: Faisceau[] = [];

  for (let rangee = 0; rangee < 2; rangee += 1) {
    // +1 = plafond (vers le haut de l'écran), -1 = plancher.
    const sens = rangee === 0 ? 1 : -1;
    for (let i = 0; i < parRangee; i += 1) {
      const indice = rangee * parRangee + i;
      const allumage = elementEnvelope(f, view, indice * 2 + 3, cycle, 0.8);
      if (allumage <= 0.01) continue;
      const ratio = parRangee === 1 ? 0.5 : i / (parRangee - 1);
      // Arc de la rangée : les extrémités reculent, donc leur faisceau est plus
      // petit et plus voilé, et la rangée bombe légèrement vers le fond.
      const arc = ARC_PROFONDEUR * Math.pow(Math.abs(ratio - 0.5) * 2, 1.7);
      // Perspective aérienne : plus une lampe recule, plus la fumée voile son
      // faisceau. La profondeur ne tient pas qu'à la taille — la brume fait le
      // plus gros du travail, et c'est ce que l'œil lit en premier.
      const voile = 1 / (1 + arc * 0.45);
      // Les têtes sont posées en écran, pile sur le bord (haut ou bas), puis
      // ramenées dans la salle à la profondeur de l'arc : la rangée longe le
      // bord au lieu de flotter dans le cadre, comme un portique de salle. Elle
      // reste rectiligne — l'arc ne joue que sur la taille et le voile.
      const xEcran = cam.cx + (ratio - 0.5) * w * RANGEE_LARGEUR;
      const yEcran = sens > 0 ? 0 : h;
      // Bout du faisceau, posé en écran puis ramené dans la salle. Fermé, il
      // plonge vers le bord opposé ; ouvert, il s'écarte vers les côtés et
      // remonte vers le centre — les deux rideaux s'ouvrent en s'écartant.
      const xe = cam.cx + (ratio - 0.5) * w * (0.9 + 1.6 * ouverture);
      const ye = cam.cy + sens * h * (0.45 - 0.35 * ouverture);
      faisceaux.push({
        origine: cibleEcran(cam, xEcran, yEcran, CAMERA_Z + arc),
        cible: cibleEcran(cam, xe, ye, profondeurFin + arc * 0.25),
        demiLargeur: masse,
        demiLargeurFin: masse * 1.4,
        hue: lampHue(f, indice),
        saturation: Math.min(1, f.palette.saturation + 0.06) * (0.72 + 0.28 * voile),
        lightness: f.palette.lightness + 0.08,
        alpha: alpha * allumage * voile,
        zTri: arc,
      });
    }
  }

  // Du plus lointain au plus proche : une lampe des bords recule, et un
  // faisceau proche doit passer devant le sien. Sans ce tri, l'arc se lirait à
  // l'envers et la profondeur disparaîtrait.
  faisceaux.sort((gauche, droite) => droite.zTri - gauche.zTri);
  for (const faisceau of faisceaux) dessineFaisceau(ctx, cam, faisceau, f.haze);

  // Les têtes, posées après les faisceaux pour rester visibles.
  for (const faisceau of faisceaux) {
    const a = projette(cam, faisceau.origine);
    if (a === null) continue;
    const rayon = Math.max((0.055 / a.depth) * cam.focal, 2);
    ctx.fillStyle = paint(faisceau.hue, 0.95, 0.86, faisceau.alpha * 1.4);
    ctx.beginPath();
    ctx.arc(a.x, a.y, rayon, 0, Math.PI * 2);
    ctx.fill();
  }
};

/** Famille à profondeur : le double rideau de projecteurs. */
export const RIDEAU_FAMILIES = { rideaux } as const;
