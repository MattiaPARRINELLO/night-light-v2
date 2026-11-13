/**
 * Plan du mode direct.
 *
 * Le direct n'a pas d'analyse : impossible de savoir à l'avance où sont les
 * couplets, les refrains et les impacts. On ne fige donc pas une scène unique
 * pour toute la soirée (l'ancien plan ne changeait jamais de famille ni de
 * couleur) : on déroule une progression longue, variée et déterministe, que la
 * direction musicale (`liveDirector`) vient frapper en temps réel.
 *
 * Le plan est une simple horloge de scènes. Les évènements réels (temps forts,
 * impacts, montées) ne modifient pas la scène, ils modifient la lumière : c'est
 * la même séparation que dans le mode analysé, où le plan porte la structure et
 * le rendu porte la musique.
 */

import type { FamilyId, Mood, Scene, SceneRole, ShowPlan } from "./show";
import { CONCERT_FAMILIES, HARD_FAMILIES, dropSignature } from "./show";
import { hash01 } from "./series";

/**
 * Durée générée : douze heures. Un plan ne se reconstruit pas en cours de
 * soirée, et une écoute plus longue n'a pas besoin d'exister : au-delà, la
 * dernière scène reste à l'écran.
 */
const LIVE_PLAN_SECONDS = 12 * 60 * 60;
/** Durée minimale et maximale d'une scène, en secondes. */
const SCENE_MIN_SEC = 24;
const SCENE_MAX_SEC = 42;
/** Une palette tient plusieurs scènes : la salle change de couleur par bloc. */
const PALETTE_BLOCK = 6;
/** Longueur de l'arc d'énergie, en secondes : une respiration lente du plateau. */
const ENERGY_ARC_SEC = 210;

interface LivePalette {
  name: string;
  hue: number;
  accent: number;
  spread: number;
}

/**
 * Palettes du direct.
 *
 * Volontairement contrastées et saturées : le direct doit tenir une salle sans
 * analyse, donc sans la couleur « du morceau ». Elles tournent par blocs pour
 * qu'une soirée ne reste jamais sur une seule teinte.
 */
const LIVE_PALETTES: LivePalette[] = [
  { name: "magenta-cyan", hue: 318, accent: 188, spread: 44 },
  { name: "azur-orange", hue: 212, accent: 26, spread: 40 },
  { name: "émeraude-magenta", hue: 152, accent: 320, spread: 42 },
  { name: "violet-jaune", hue: 268, accent: 52, spread: 46 },
  { name: "corail-turquoise", hue: 6, accent: 176, spread: 36 },
  { name: "ambre-azur", hue: 34, accent: 214, spread: 38 },
  { name: "cyan-rose", hue: 186, accent: 336, spread: 42 },
  { name: "jaune-bleu", hue: 48, accent: 222, spread: 40 },
];

/**
 * Familles du direct.
 *
 * Le plateau de concert est majoritaire (le profil `dynamic` l'accompagne de ses
 * nappes), mais on garde les figures de rave et les nappes : une soirée qui
 * n'aurait que des lyres tournerait en rond. Les familles purement « ambiance
 * calme » restent minoritaires, le direct n'étant pas un morceau d'ambient.
 */
const LIVE_FAMILIES: FamilyId[] = [
  ...CONCERT_FAMILIES,
  "beams",
  "tunnel",
  "bars",
  "grid",
  "shutters",
  "spiral",
  "spots",
  "crossfire",
  "burst",
  "gobos",
  "pendule",
  "couronne",
  "pluie",
  "portique",
  "etoile",
  "vortex",
  "mandala",
  "treillis",
  "rideaux",
  "mirror",
  "parade",
  "curtain",
  "waves",
  "particles",
  "rings",
];

/** Rôles qui se succèdent : une phrase de concert, jamais un rôle figé. */
const ROLE_CYCLE: SceneRole[] = ["couplet", "refrain", "montee", "refrain", "drop", "couplet"];

/** Mélange déterministe d'une liste, sans modifier l'original. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(hash01(seed * 131 + index * 17) * (index + 1));
    const current = result[index]!;
    result[index] = result[pick]!;
    result[pick] = current;
  }
  return result;
}

/** Humeur d'une scène à partir de son rang et de son arc d'énergie. */
function moodAt(index: number, energy: number): Mood {
  // Toutes les sept scènes environ, le plateau respire : une scène posée évite
  // que la soirée ne soit un mur de lumière continu.
  if (index > 0 && index % 7 === 6) return "calme";
  if (energy >= 0.78) return "explosif";
  if (energy >= 0.58) return "pulse";
  return "aerien";
}

/** Intensité propre de la scène, cohérente avec son humeur. */
function intensityAt(mood: Mood, energy: number): number {
  if (mood === "calme") return 0.42;
  if (mood === "explosif") return Math.min(0.92, 0.72 + energy * 0.2);
  return 0.56 + energy * 0.24;
}

/**
 * Construit le plan du direct.
 *
 * Même graine ⇒ même plan : une reconnexion ou un changement de réglage ne
 * redistribue pas les scènes au milieu d'une soirée.
 */
export function buildLivePlan(seedOverride?: number): ShowPlan {
  const seed = seedOverride ?? 20_260_101;
  const duration = LIVE_PLAN_SECONDS;
  // L'ordre des familles change avec la graine, mais aucune ne revient avant
  // d'avoir fait le tour du réservoir.
  const familyDeck = shuffle(LIVE_FAMILIES, seed);
  const hardDeck = shuffle(HARD_FAMILIES, seed + 977);
  const scenes: Scene[] = [];

  let start = 0;
  let index = 0;
  let previous: FamilyId | undefined;
  while (start < duration) {
    const span =
      SCENE_MIN_SEC + Math.floor(hash01(seed * 71 + index * 13) * (SCENE_MAX_SEC - SCENE_MIN_SEC));
    const end = Math.min(duration, start + span);
    const block = Math.floor(index / PALETTE_BLOCK);
    const palette = LIVE_PALETTES[block % LIVE_PALETTES.length]!;
    // L'arc d'énergie respire lentement : la soirée monte, redescend, remonte.
    const energy = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin((start / ENERGY_ARC_SEC) * Math.PI * 2));
    const role = index === 0 ? "intro" : (ROLE_CYCLE[index % ROLE_CYCLE.length] ?? "couplet");
    const mood = moodAt(index, energy);
    const calm = mood === "calme";

    // Une famille ne revient pas deux fois d'affilée, et le deck tourne pour que
    // toutes les figures passent. En scène calme, on préfère une nappe.
    const deck = calm
      ? shuffle<FamilyId>(["waves", "tunnel", "particles", "rings", "spiral", "pluie"], seed + index)
      : familyDeck;
    let family = deck[index % deck.length]!;
    if (family === previous) family = deck[(index + 1) % deck.length]!;
    if (family === previous) family = deck[(index + 2) % deck.length]!;
    previous = family;

    // Variante : une autre figure surgit au milieu de la scène. Le deck hard est
    // réservé aux profils agressifs, ici il sert simplement de réservoir
    // alternatif pour ne jamais répéter la famille principale.
    const variantDeck = hardDeck;
    let variant = variantDeck[index % variantDeck.length]!;
    if (variant === family) variant = variantDeck[(index + 1) % variantDeck.length]!;

    const secondary = index % 2 === 0 ? palette.accent : palette.hue;
    const signature =
      role === "drop"
        ? dropSignature(seed, Math.floor(index / ROLE_CYCLE.length), Math.max(0.55, energy))
        : undefined;

    scenes.push({
      index,
      start,
      end,
      family,
      variant,
      backdrop: "waves",
      palette: {
        name: palette.name,
        hue: secondary,
        accent: secondary === palette.hue ? palette.accent : palette.hue,
        spread: palette.spread,
        saturation: calm ? 0.7 : 0.92,
        lightness: calm ? 0.5 : 0.66,
      },
      intensity: intensityAt(mood, energy),
      // Le direct change de scène sans évènement musical : un fondu franc mais
      // sans coupure, pour que la nouvelle figure ne « saute » pas à l'écran.
      fadeIn: role === "drop" ? 0.35 : 0.7,
      fadeOut: 0.9,
      mood,
      role,
      reason: index === 0 ? "ouverture" : role === "drop" ? "drop" : "cycle",
      ...(signature !== undefined ? { drop: signature } : {}),
    });

    start = end;
    index += 1;
  }

  return {
    duration,
    seed,
    scenes,
    // Le direct est une salle de concert : plateau habité, nappes de fond,
    // strobes sur les vrais impacts. Le mode `hard` reste disponible par réglage.
    profile: "dynamic",
    barStarts: [],
    track: {
      name: LIVE_PALETTES[0]!.name,
      hue: LIVE_PALETTES[0]!.hue,
      accent: LIVE_PALETTES[0]!.accent,
      spread: LIVE_PALETTES[0]!.spread,
      colors: [LIVE_PALETTES[0]!.hue, LIVE_PALETTES[0]!.accent],
    },
    backdrop: "waves",
  };
}
