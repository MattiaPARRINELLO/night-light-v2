/** Schéma de l'analyse produite par le serveur (`POST /api/analyze`). */
export const ANALYSIS_SCHEMA = 2 as const;

export type SectionLabel = "calme" | "montee" | "intense" | "descente" | "silence";

/**
 * Rôle d'une section dans la structure du morceau, déduit de la répétition de
 * son matériau musical (voir `server/structure.py`). `section` couvre ce qui
 * n'entre dans aucune case : un passage unique et ni intro, ni pont.
 */
export type SectionKind =
  | "intro"
  | "couplet"
  | "refrain"
  | "pont"
  | "outro"
  | "section";

/** Point d'une courbe : `[secondes, valeur 0..1]`. */
export type Point = [number, number];

export interface Section {
  start: number;
  end: number;
  label: SectionLabel;
  /** Énergie moyenne normalisée de la section, 0..1. */
  energy: number;
  /**
   * Groupe de matériau musical (« A », « B »…) : deux sections de même groupe
   * jouent le même passage. Vide si la structure n'a pas pu être établie.
   */
  group?: string;
  /** Rôle de la section dans le morceau. */
  kind?: SectionKind;
  /** Rang de cette occurrence dans son groupe (1 = première). 0 si sans groupe. */
  occurrence?: number;
}

export interface Build {
  /** Début de la montée. */
  start: number;
  /** Fin de la montée (l'impact attendu). */
  end: number;
  /** Force de l'impact attendu, 0..1. */
  strength: number;
}

export interface Analysis {
  schema: typeof ANALYSIS_SCHEMA;
  /** Durée du morceau, en secondes. */
  duration: number;
  /** Tempo estimé en BPM. */
  tempo: number;
  /** Nombre de temps détectés. */
  beatCount: number;
  /** Seconds per beat, dérivé du tempo. */
  beatPeriod: number;
  /** Temps forts détectés, en secondes, triés. */
  beats: number[];
  /** Attaques détectées, en secondes, triées. */
  onsets: number[];
  /** Courbe d'énergie globale, 0..1. */
  energy: Point[];
  /** Courbe des basses (30-150 Hz), 0..1. */
  bass: Point[];
  /** Courbe des médiums (150-2000 Hz), 0..1. */
  mid: Point[];
  /** Courbe des aigus (2000-10000 Hz), 0..1. */
  high: Point[];
  /** Sections musicales détectées. */
  sections: Section[];
  /** Montées d'énergie détectées, avec l'impact qui les conclut. */
  builds: Build[];
}

export interface RenderSettings {
  /** Intensité visuelle générale, 0.2 à 1.5. */
  intensity: number;
  /** Intensité des flashs, 0 à 1.5 (0 = aucun flash). */
  flashes: number;
  /** Mode confort : moins d'éléments, mouvements ralentis, jamais de flash. */
  reduced: boolean;
}

export const DEFAULT_SETTINGS: RenderSettings = {
  intensity: 1,
  flashes: 0.9,
  reduced: false,
};
