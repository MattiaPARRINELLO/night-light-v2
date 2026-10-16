import type { Mood, Palette } from "../show";
import { hash01 } from "../series";
import { shiftHue } from "../color";
import type { FrameState } from "./types";

/**
 * Accords harmoniques : les écarts de teinte dont une scène tire ses couleurs.
 *
 * Une scène à plusieurs sources n'est jamais monochrome, et elle n'est pas
 * bariolée pour autant : ses teintes sont prises dans un accord du cercle
 * chromatique. Plus le morceau change de scène, plus l'accord change : l'univers
 * coloré se déploie sans jamais quitter l'identité du morceau.
 */
const ACCORDS: readonly (readonly number[])[] = [
  [0, 150, 210], // demi-complémentaire
  [0, 120, 240], // triade
  [0, 90, 180, 270], // carré
  [0, 60, 120, 180, 240, 300], // hexade : le cercle entier, par sixièmes
];

/**
 * Accords par humeur.
 *
 * C'est le geste qui rend la couleur lisible : un passage calme tient deux ou
 * trois teintes serrées, un passage fort ouvre le cercle jusqu'à l'hexade. La
 * couleur du spectacle devient donc un récit — elle s'élargit avec la musique —
 * au lieu d'un tirage au sort. Le tirage par scène reste, mais *à l'intérieur*
 * de cette famille d'accords, pour que deux scènes voisines ne se ressemblent
 * jamais tout à fait.
 */
const ACCORDS_PAR_HUMEUR: Record<Mood, readonly (readonly number[])[]> = {
  sombre: [[0, 150, 210]],
  calme: [
    [0, 150, 210],
    [0, 120, 240],
  ],
  aerien: [
    [0, 120, 240],
    [0, 90, 180, 270],
  ],
  pulse: [
    [0, 120, 240],
    [0, 90, 180, 270],
  ],
  explosif: [
    [0, 90, 180, 270],
    [0, 60, 120, 180, 240, 300],
  ],
};

/**
 * Teintes d'un accord, en degrés absolus.
 *
 * L'écart de l'accent du morceau remplace le 180 de l'accord quand celui-ci en
 * comporte un : la complémentaire d'une scène est alors exactement celle de la
 * palette du morceau, et non un 180 générique. Les accords sans 180 (demi-
 * complémentaire, triade) reçoivent l'accent en second — c'est lui qui signe le
 * morceau. Enfin, deux membres peuvent se rejoindre si l'accent tombe près d'une
 * tierce : on écarte alors le doublon, pour que la diversité soit réelle.
 *
 * Le tirage ne dépend que de l'index de la scène et de son humeur : une scène
 * garde son accord du début à la fin, le morceau le renouvelle d'une scène à
 * l'autre.
 */
export function sceneChord(palette: Palette, sceneIndex: number, seed: number, mood?: Mood): number[] {
  const complement = (((palette.accent - palette.hue) % 360) + 360) % 360;
  const tirage = hash01(sceneIndex * 7919 + seed * 131);
  // Sans humeur (appelant de test, ou contexte sans scène), on retombe sur la
  // gamme complète : le tirage reste alors purement fonctionnel.
  const candidats = mood !== undefined ? ACCORDS_PAR_HUMEUR[mood] : ACCORDS;
  const base = candidats[Math.floor(tirage * candidats.length)] ?? ACCORDS[0]!;
  const offsets = base.includes(180)
    ? base.map((ecart) => (ecart === 180 ? complement : ecart))
    : [0, complement, ...base.slice(1)];
  const hues: number[] = [];
  for (const ecart of offsets) {
    const hue = shiftHue(palette.hue, ecart);
    if (hues.some((deja) => Math.abs((((deja - hue) % 360) + 540) % 360 - 180) < 12)) continue;
    hues.push(hue);
  }
  return hues;
}

/** Pas de parcours d'un accord : premier avec sa longueur, pour en visiter tous les membres. */
function chordStep(length: number): number {
  for (const pas of [2, 3, 5, 7]) if (length % pas !== 0) return pas;
  return 1;
}

/**
 * Teinte de la lampe `index` d'un ensemble, dans l'accord de la scène.
 *
 * Les lampes parcourent l'accord avec un pas premier avec sa longueur, puis une
 * rotation tirée du seed : deux lampes voisines ne portent donc jamais la même
 * teinte, et la rangée se lit multicolore au lieu d'alternée. Un léger écart par
 * lampe (`spread`) achève de distinguer deux lampes de même teinte — sans jamais
 * sortir de la gamme, puisque l'écart reste petit devant celui de l'accord.
 */
export function lampHue(f: FrameState, index: number): number {
  const accord = sceneChord(f.palette, f.scene.index, f.seed, f.scene.mood);
  const pas = chordStep(accord.length);
  const rotation = Math.floor(hash01(f.scene.index * 104729 + f.seed) * accord.length);
  const membre =
    accord[((index * pas + rotation) % accord.length + accord.length) % accord.length] ?? f.palette.hue;
  return shiftHue(membre, (hash01(index * 2711 + f.seed) - 0.5) * f.palette.spread * 0.45);
}

/**
 * Teinte de contraste d'une scène : le membre de l'accord le plus éloigné de sa
 * teinte dominante.
 *
 * C'est ce qui empêche l'image d'être d'une seule couleur : le fond, le halo
 * commun et le foyer de chaque famille s'en servent, donc la scène porte
 * toujours au moins deux teintes distinctes, même quand toutes les formes
 * partagent la même gamme.
 */
export function contrastHue(f: FrameState): number {
  const accord = sceneChord(f.palette, f.scene.index, f.seed, f.scene.mood);
  let best = f.palette.hue;
  let bestGap = -1;
  for (const hue of accord) {
    const gap = Math.abs((((hue - f.palette.hue) % 360) + 540) % 360 - 180);
    if (gap > bestGap) {
      bestGap = gap;
      best = hue;
    }
  }
  return best;
}
