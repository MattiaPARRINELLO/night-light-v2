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

import type { Analysis, HardMode } from "../types";
import type { JobTimings } from "../core/api";
import type { FamilyId, Mood, SceneRole } from "../core/show";

export const CONTROL_CHANNEL = "night-light-control";
/** Version du protocole. Incrémentée à toute rupture de compatibilité. */
export const CONTROL_VERSION = 1;

export type ShowMode = "live" | "syncing" | "show-synced" | "show-local" | "paused" | "lost";

export type ScreenName = "drop" | "analysis" | "error" | "show";

/**
 * Chronologie d'un morceau résolu, en millisecondes depuis la détection.
 * `null` = étape pas encore atteinte. Le dashboard l'affiche tel quel.
 */
export interface TrackTimings {
  detectedAt: number;
  foundMs: number | null;
  downloadedMs: number | null;
  analyzedMs: number | null;
  partialMs: number | null;
  syncedMs: number | null;
  firstFrameMs: number | null;
  planMs: number | null;
  audioCache: boolean;
  analysisCache: boolean;
  /** Durées détaillées des phases de la dernière analyse. */
  phases: Record<string, number> | null;
}

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
    /**
     * Fenêtre réellement analysée quand le show tourne sur une analyse rapide ;
     * `null` pour une analyse finale. Le dashboard s'en sert pour savoir s'il
     * doit redemander les courbes à la fin de l'analyse.
     */
    coverage: [number, number] | null;
  } | null;
  settings: {
    intensity: number;
    flashes: number;
    reduced: boolean;
    noflash: boolean;
    /** Profil esthétique : automatique, hard forcé ou standard. */
    hard: HardMode;
    /** Entrée dans le show : voile noir historique ou fondu enchaîné. */
    transition: "black" | "crossfade";
  };
  limits: { maxFileBytes: number; maxDurationSec: number } | null;
  debugOverlay: boolean;
  error: { title: string; message: string; detail: string } | null;
  /**
   * Information discrète, affichée en bas : un repli n'est pas une erreur et ne
   * doit jamais prendre l'écran.
   */
  notice: { text: string; at: number } | null;
  /**
   * Échec de la résolution automatique du morceau du lecteur. Volontairement
   * réservé au dashboard : l'écran de show continue en direct.
   */
  resolve: { title: string; artist: string; detail: string; at: number } | null;
  /** Chronologie détecté → trouvé → téléchargé → analysé → calé → premier frame. */
  timings: TrackTimings | null;
  /** Effet forcé depuis le studio, s'il y en a un à l'écran. */
  effect: { family: FamilyId; label: string } | null;
  /** Dernières lignes du journal de debug, pour le journal du dashboard. */
  log: string[];
}

/**
 * Effet imposé à l'écran de show depuis le studio.
 *
 * Il porte à la fois l'apparence (famille, palette, rôle) et la petite timeline
 * synthétique qui l'anime : l'écran de projection n'a donc pas besoin d'un
 * morceau analysé pour jouer l'effet.
 */
export interface EffectOverride {
  family: FamilyId;
  variant: FamilyId;
  role: SceneRole;
  mood: Mood;
  hue: number;
  /** Écart entre la teinte principale et la complémentaire, en degrés. */
  spread: number;
  saturation: number;
  lightness: number;
  tempo: number;
  energy: number;
  bass: number;
  high: number;
  impacts: boolean;
  seed: number;
  speed: number;
  intensity: number;
  flashes: number;
  reduced: boolean;
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
  /** Force un effet du studio sur l'écran de show, ou rend la main au show. */
  | { type: "set-effect"; effect: EffectOverride | null }
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
      /** Chronologie serveur, pour l'affichage du dashboard. */
      timings?: JobTimings;
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
/** État de la liaison avec le relais serveur. */
export type ControlStatus = "connecting" | "open" | "offline";

/** Adresse du relais : même origine que la page, donc téléphone comme PC. */
function controlSocketUrl(): string {
  const configured = import.meta.env.VITE_CONTROL_WS as string | undefined;
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/control`;
}

/**
 * Lien de contrôle : publie l'état d'un côté, envoie des commandes de l'autre.
 *
 * Deux transports, dans cet ordre :
 *   1. un WebSocket vers `/api/control`, qui traverse les appareils (téléphone
 *      → PC) via le relais serveur ;
 *   2. `BroadcastChannel`, qui reste le repli instantané quand les deux pages
 *      vivent dans le même navigateur et que le serveur est injoignable.
 *
 * L'émission choisit un seul transport (le WebSocket dès qu'il est ouvert),
 * pour ne pas doubler les commandes sur une machine locale. La réception, elle,
 * écoute les deux : chaque page ignore de toute façon les messages qu'elle ne
 * sait pas traiter.
 */
export class ControlLink {
  private readonly channel: BroadcastChannel;
  private socket: WebSocket | null = null;
  private handler: ((message: ControlMessage) => void) | null = null;
  private statusHandler: ((status: ControlStatus) => void) | null = null;
  private closed = false;
  private retry = 0;
  private retryTimer: number | null = null;

  constructor() {
    this.channel = new BroadcastChannel(CONTROL_CHANNEL);
    this.channel.onmessage = (event: MessageEvent<ControlMessage>) => this.receive(event.data);
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.close();
    this.socket = null;
    this.channel.close();
  }

  onMessage(handler: (message: ControlMessage) => void): void {
    this.handler = handler;
  }

  /** Préviens l'interface de l'état de la liaison distante. */
  onStatus(handler: (status: ControlStatus) => void): void {
    this.statusHandler = handler;
    handler(this.socket === null ? "connecting" : this.socket.readyState === WebSocket.OPEN ? "open" : "connecting");
  }

  private connect(): void {
    if (this.closed) return;
    try {
      const socket = new WebSocket(controlSocketUrl());
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.socket !== socket) return;
        this.retry = 0;
        this.statusHandler?.("open");
      });
      socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data !== "string") return;
        try {
          this.receive(JSON.parse(event.data) as ControlMessage);
        } catch {
          // Un message illisible est ignoré : le canal reste ouvert.
        }
      });
      const drop = (): void => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.statusHandler?.("offline");
        this.scheduleReconnect();
      };
      socket.addEventListener("close", drop);
      socket.addEventListener("error", () => socket.close());
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer !== null) return;
    const delay = Math.min(5000, 400 * 2 ** this.retry);
    this.retry += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private receive(message: ControlMessage): void {
    if (!supported(message)) return;
    this.handler?.(message);
  }

  /** Un seul transport par message : WebSocket s'il est ouvert, sinon canal local. */
  private transmit(message: ControlMessage): void {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    this.channel.postMessage(message);
  }

  /** Publie l'état complet (côté show). */
  publishState(state: ShowState): void {
    this.transmit({ version: CONTROL_VERSION, at: Date.now(), state } satisfies ControlMessage);
  }

  /** Renvoie une seule fois l'analyse complète au dashboard (côté show). */
  publishAnalysis(payload: AnalysisPayload): void {
    this.transmit({ version: CONTROL_VERSION, at: Date.now(), analysisPayload: payload } satisfies ControlMessage);
  }

  /** Envoie une commande (côté dashboard ou studio). */
  send(command: DashboardCommand): void {
    this.transmit({ version: CONTROL_VERSION, at: Date.now(), command } satisfies ControlMessage);
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
    settings: { intensity: 1, flashes: 0.9, reduced: false, noflash: false, hard: "auto", transition: "crossfade" },
    limits: null,
    debugOverlay: false,
    error: null,
    notice: null,
    resolve: null,
    timings: null,
    effect: null,
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
