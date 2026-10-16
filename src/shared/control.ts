/**
 * Protocole de contrôle entre l'écran de show et le dashboard.
 *
 * Les deux pages vivent dans le même navigateur (souvent deux écrans, deux
 * fenêtres) : un `BroadcastChannel` suffit, et il est instantané. Le serveur
 * n'a rien à relayer, il continue de servir ce qu'il sait déjà faire (fichiers,
 * analyse, position de lecture).
 *
 * Sens de circulation :
 *   show  → dashboard : `ShowState`, publié plusieurs fois par seconde ;
 *   dashboard → show  : `DashboardCommand`, à la demande.
 *
 * Tout est typé et versionné : si un jour les deux pages ne sont pas de la même
 * version, elles se ignorent au lieu de se comprendre de travers.
 */

import type { Analysis } from "../types";

export const CONTROL_CHANNEL = "night-light-control";
/** Version du protocole. Incrémentée à toute rupture de compatibilité. */
export const CONTROL_VERSION = 1;

export type ShowMode = "live" | "syncing" | "show-synced" | "show-local" | "paused" | "lost";

export type ScreenName = "drop" | "analysis" | "error" | "show";

/** Ce que l'écran de show sait de lui-même, publié pour le dashboard. */
export interface ShowState {
  version: number;
  /** Horodatage d'émission, en millisecondes epoch. */
  at: number;
  page: "show";
  screen: ScreenName;
  mode: ShowMode;
  /** false tant que le show n'a pas reçu de signe de vie du dashboard. */
  controlled: boolean;
  capture: {
    open: boolean;
    state: string;
    source: string;
    error: string;
    rate: number;
    messages: number;
    lastAt: number;
  };
  audio: {
    rms: number;
    energy: number;
    bass: number;
    mid: number;
    high: number;
    transient: number;
  };
  /** Valeurs lissées réellement envoyées au rendu. */
  smooth: {
    rms: number;
    energy: number;
    bass: number;
    mid: number;
    high: number;
    transient: number;
  };
  render: {
    liveFps: number;
    liveQuality: number;
    liveFrame: number;
    showFps: number;
    quality: number;
    frame: number;
  };
  sync: {
    source: string;
    playerTitle: string;
    expectedTitle: string;
    playerMs: number;
    showMs: number;
    driftMs: number;
    latencyMs: number;
    attempts: number;
    match: string;
    correlation: number | null;
  };
  analysis: {
    title: string;
    artist: string;
    durationSec: number;
    tempo: number;
    beats: number;
    builds: number;
    sections: number;
  } | null;
  settings: {
    intensity: number;
    flashes: number;
    reduced: boolean;
    noflash: boolean;
  };
  limits: { maxFileBytes: number; maxDurationSec: number } | null;
  debugOverlay: boolean;
  error: { title: string; message: string; detail: string } | null;
  /**
   * Information discrète, affichée en bas : un repli n'est pas une erreur et ne
   * doit jamais prendre l'écran.
   */
  notice: { text: string; at: number } | null;
  /** Dernières lignes du journal de debug, pour le journal du dashboard. */
  log: string[];
}

/** Ce que le dashboard demande à l'écran de show. */
export type DashboardCommand =
  | { type: "hello" }
  | { type: "set-latency"; ms: number }
  | { type: "set-settings"; patch: Partial<ShowState["settings"]> }
  | { type: "capture"; on: boolean }
  | { type: "force-live" }
  | { type: "force-show" }
  | { type: "cancel-analysis" }
  | { type: "debug-overlay"; on: boolean }
  /** Le dashboard réclame l'analyse complète du morceau en cours. */
  | { type: "request-analysis" }
  | {
      /** Analyse terminée côté dashboard : le show prend le relais et se cale. */
      type: "analysis-ready";
      jobId: string;
      title: string;
      artist: string;
      /** Analyse complète, telle que renvoyée par l'API. */
      analysis: Analysis;
    };

/** Analyse complète envoyée du show vers le dashboard, à la demande. */
export interface AnalysisPayload {
  title: string;
  artist: string;
  analysis: Analysis;
}

export interface ControlMessage {
  version: number;
  at: number;
  state?: ShowState;
  command?: DashboardCommand;
  /** Réponse ponctuelle à `request-analysis` (le résumé `analysis` de `ShowState` ne contient pas les courbes). */
  analysisPayload?: AnalysisPayload;
}

function supported(message: ControlMessage): boolean {
  return message !== null && typeof message === "object" && message.version === CONTROL_VERSION;
}

/**
 * Lien de contrôle : publie l'état d'un côté, envoie des commandes de l'autre.
 *
 * `BroadcastChannel` ne se renvoie pas ses propres messages, ce qui est
 * exactement ce qu'on veut : chaque page ne reçoit que ce que dit l'autre.
 */
export class ControlLink {
  private readonly channel: BroadcastChannel;

  constructor() {
    this.channel = new BroadcastChannel(CONTROL_CHANNEL);
  }

  close(): void {
    this.channel.close();
  }

  onMessage(handler: (message: ControlMessage) => void): void {
    this.channel.onmessage = (event: MessageEvent<ControlMessage>) => {
      const message = event.data;
      if (!supported(message)) return;
      handler(message);
    };
  }

  /** Publie l'état complet (côté show). */
  publishState(state: ShowState): void {
    this.channel.postMessage({ version: CONTROL_VERSION, at: Date.now(), state } satisfies ControlMessage);
  }

  /** Renvoie une seule fois l'analyse complète au dashboard (côté show). */
  publishAnalysis(payload: AnalysisPayload): void {
    this.channel.postMessage({ version: CONTROL_VERSION, at: Date.now(), analysisPayload: payload } satisfies ControlMessage);
  }

  /** Envoie une commande (côté dashboard). */
  send(command: DashboardCommand): void {
    this.channel.postMessage({ version: CONTROL_VERSION, at: Date.now(), command } satisfies ControlMessage);
  }
}

/** État vide, pour un dashboard sans écran de show connecté. */
export function emptyShowState(): ShowState {
  return {
    version: CONTROL_VERSION,
    at: 0,
    page: "show",
    screen: "drop",
    mode: "live",
    controlled: false,
    capture: { open: false, state: "inactive", source: "", error: "", rate: 0, messages: 0, lastAt: 0 },
    audio: { rms: 0, energy: 0, bass: 1 / 3, mid: 1 / 3, high: 1 / 3, transient: 0 },
    smooth: { rms: 0, energy: 0, bass: 1 / 3, mid: 1 / 3, high: 1 / 3, transient: 0 },
    render: { liveFps: 0, liveQuality: 0, liveFrame: 0, showFps: 0, quality: 0, frame: 0 },
    sync: {
      source: "",
      playerTitle: "",
      expectedTitle: "",
      playerMs: 0,
      showMs: 0,
      driftMs: 0,
      latencyMs: 0,
      attempts: 0,
      match: "",
      correlation: null,
    },
    analysis: null,
    settings: { intensity: 1, flashes: 0.9, reduced: false, noflash: false },
    limits: null,
    debugOverlay: false,
    error: null,
    notice: null,
    log: [],
  };
}

/** Libellés courts et stables pour l'interface. */
export const MODE_LABELS: Record<ShowMode, string> = {
  live: "Live",
  syncing: "Calage…",
  "show-synced": "Show calé",
  "show-local": "Show local",
  paused: "En pause",
  lost: "Synchro perdue",
};

export const SCREEN_LABELS: Record<ScreenName, string> = {
  drop: "Dépôt",
  analysis: "Analyse",
  error: "Erreur",
  show: "Show",
};
