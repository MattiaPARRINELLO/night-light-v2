import { clamp01, hash01, smoothstep } from "../series";
import type { TrackView } from "../view";
import type { FrameState } from "./types";

/**
 * Enveloppe d'allumage et d'extinction d'un élément.
 *
 * Un projecteur ne s'allume pas d'un coup : il monte, tient, puis s'éteint. Le
 * cycle se compte en temps forts — donc la lumière vit avec la musique — et
 * `index` décale la phase de chaque élément : ils s'allument l'un après l'autre
 * au lieu de clignoter en bloc. Les montées et descentes sont lissées, jamais
 * des sauts : c'est ce qui évite l'élément qui « apparaît en pleine scène ».
 *
 * `duty` est la part du cycle pendant laquelle l'élément reste allumé.
 *
 * `phaseOffset` décale le cycle d'une fraction fixe, en plus du tirage par
 * `index`. Deux éléments d'un même ensemble peuvent ainsi se relayer franchement
 * (`0.5` les met exactement à l'opposé) au lieu de dépendre du seul hasard.
 */
export function elementEnvelope(
  f: FrameState,
  view: TrackView,
  index: number,
  cycleBeats = 16,
  duty = 0.6,
  phaseOffset = 0,
): number {
  const cycle = Math.max(1, cycleBeats);
  let phase: number;
  if (view.beats.length === 0) {
    // Sans grille rythmique (mode direct), le cycle se compte en secondes : la
    // lumière doit vivre quand même.
    phase = (f.t / (cycle * 0.45) + hash01(index * 97 + f.seed) + phaseOffset) % 1;
  } else {
    phase = ((f.beatIndex + clamp01(f.beatPhase)) / cycle + hash01(index * 97 + f.seed) + phaseOffset) % 1;
  }
  phase = ((phase % 1) + 1) % 1;

  const montee = 0.15;
  const extinction = 0.25;
  const allume = Math.max(montee + extinction, duty);
  if (phase >= allume) return 0;
  if (phase < montee) return smoothstep(0, montee, phase);
  const debutExtinction = allume - extinction;
  if (phase < debutExtinction) return 1;
  return 1 - smoothstep(debutExtinction, allume, phase);
}

/**
 * Bascule de couleur : la part de temps pendant laquelle une forme projetée
 * quitte sa teinte pour la complémentaire.
 *
 * C'est le geste qui remplace le déplacement. Quand treize gobos tournent
 * ensemble, en faire bouger un de plus ne se lit pas — alors que le faire
 * changer de couleur, oui. Sur scène, c'est exactement ce que fait un
 * projecteur qui tourne sa roue de couleurs : le motif ne bouge pas, mais
 * l'œil est attiré. La bascule tombe sur la grille rythmique (le cycle se
 * compte en temps forts), elle n'a lieu que sur une poignée de formes, et elle
 * est progressive — la teinte glisse vers l'opposée et revient, au lieu de
 * sauter.
 *
 * `index` décale le moment de chaque forme : sans ce décalage, tout le cadre
 * basculerait au même instant et l'effet se lirait comme un clignotement
 * général. `probabilite` décide, à chaque cycle, si la forme bascule : réglé
 * bas, une ou deux formes seulement portent la complémentaire à un instant
 * donné.
 *
 * Renvoie 0..1 : 0 = teinte d'origine, 1 = complémentaire.
 */
export function colorFlip(
  f: FrameState,
  view: TrackView,
  index: number,
  cycleBeats = 8,
  part = 0.22,
  probabilite = 0.55,
): number {
  const cycle = Math.max(1, cycleBeats);
  const duree = clamp01(part);
  // Décalage fixe par forme : les bascules sont réparties sur le cycle, donc
  // une ou deux seulement sont en cours à un instant donné.
  const decalage = hash01(index * 53 + f.seed);
  const position =
    view.beats.length === 0
      ? f.t / (cycle * 0.45)
      : (f.beatIndex + clamp01(f.beatPhase)) / cycle;
  const phase = position + decalage;
  const moment = Math.floor(phase);
  const local = phase - moment;
  // Toutes les formes ne basculent pas à chaque cycle : le tirage en désigne
  // une minorité. Sans lui, tout le cadre virait à la complémentaire d'un bloc.
  if (hash01(moment * 7919 + index * 131 + f.seed) > probabilite) return 0;
  if (local >= duree) return 0;
  const montee = duree * 0.42;
  const descente = duree * 0.42;
  if (local < montee) return smoothstep(0, montee, local);
  if (local < duree - descente) return 1;
  return 1 - smoothstep(duree - descente, duree, local);
}

/**
 * Balayage calé sur le tempo.
 *
 * La cible change à chaque pas — un temps fort par défaut, ou un groupe — et
 * l'interpolation arrive vite puis tient la note. Les faisceaux bougent donc
 * *avec* la musique, au lieu de dériver à côté d'elle à vitesse fixe. C'est la
 * différence entre un projecteur qui balaie et un projecteur qui joue.
 *
 * `offset` décale la phase d'un projecteur : sans lui, toute la rangée partirait
 * du même côté au même instant.
 */
export function beatSwing(
  f: FrameState,
  view: TrackView,
  spread: number,
  beatsPerStep = 1,
  offset = 0,
): number {
  // Aucune grille détectée (mode direct, morceau sans rythme) : on retombe sur
  // une oscillation lente plutôt qu'un balayage figé.
  if (view.beats.length === 0) return Math.sin(f.t * 0.37 + offset) * spread * 0.5;

  const pas = Math.max(1, Math.round(beatsPerStep));
  // Le décalage porte sur la position elle-même : deux lampes voisines sont
  // alors à des points différents de leur course, au lieu de bouger ensemble.
  const position = f.beatIndex + clamp01(f.beatPhase) + offset;
  const bloc = Math.floor(position / pas);
  const local = clamp01(position / pas - bloc);
  // L'ampleur suit l'énergie : une salle calme se contente d'un balayage
  // étroit, un passage fort ouvre largement. La cadence, elle, suit le tempo.
  const ampleur = spread * (0.7 + 0.5 * clamp01(f.energy));
  const depart = (hash01(bloc * 7919 + f.seed) - 0.5) * ampleur;
  const arrivee = (hash01((bloc + 1) * 7919 + f.seed) - 0.5) * ampleur;
  // La course se fait sur les 70 % du pas : le faisceau est en place juste
  // après le temps fort, puis tient sa position le reste du temps.
  return depart + (arrivee - depart) * smoothstep(0, 0.7, local);
}
