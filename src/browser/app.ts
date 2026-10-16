/**
 * Écran de spectacle : cœur de l'application.
 *
 * Ce fichier détient l'état partagé et le cycle de vie. Les méthodes sont
 * réparties par domaine dans des modules voisins, chacun exposant un
 * `install…(App)` qui greffe ses méthodes sur le prototype :
 *
 *   - `app-drop`     dépôt de fichier, analyse locale, retour à l'écran de dépôt
 *   - `app-resolve`  résolution par titre/artiste, suivi du lecteur externe
 *   - `app-live`     mode direct (capture du son du PC, visualiseur, rendu live)
 *   - `app-sync`     show synchronisé sur un lecteur externe
 *   - `app-show`     show analysé local (lecture, commandes, clavier)
 *   - `app-control`  lien tableau de bord, réglages, latence, overlay de debug
 *   - `app-loop`     boucle de rendu, qualité, nappes de fumée, transitions, HUD
 *
 * L'état vit ici pour rester la source de vérité unique ; la logique vit dans
 * des fichiers courts et lisibles.
 */

import { AudioEngine } from "./audio";
import { fetchHealth, type Limits, type NowPlayingResponse } from "../core/api";
import { dbgLog, type DebugCategory } from "../core/debug";
import type { HazeTarget } from "../core/families";
import { EMPTY_LIVE_AUDIO, type LiveAudioFeatures } from "../core/liveAudio";
import type { ExternalPlaybackState } from "../core/playback";
import type { ShowPlan } from "../core/show";
import type { TrackView } from "../core/view";
import { ControlLink } from "../shared/control";
import { DEFAULT_SETTINGS, type Analysis, type RenderSettings } from "../types";
import { el, setStatus, setUploadState, showScreen } from "./ui";

import { installControl } from "./app-control";
import { installDrop } from "./app-drop";
import { installLive } from "./app-live";
import { installLoop } from "./app-loop";
import { installResolve } from "./app-resolve";
import { installShow } from "./app-show";
import { installSync } from "./app-sync";

interface Session {
  jobId: string;
  title: string;
  duration: number;
  startedAt: number;
}

/** Instantané de la capture système, pour l'overlay de debug. */
interface CaptureDebug {
  /** Flux SSE : fermé, en connexion, ouvert ou en erreur. */
  link: "fermé" | "connexion…" | "ouvert" | "erreur";
  messages: number;
  lastAt: number;
  rate: number;
  state: string;
  active: string;
  source: string;
  error: string;
}

/** Instantané de la synchronisation, pour l'overlay de debug. */
interface SyncDebug {
  phase: "LIVE" | "SYNCING" | "SHOW_SYNCED" | "SHOW_LOCAL" | "PAUSED" | "LOST";
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
  resyncAt: number;
}

export class App {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** Nappes de fumée (voir HazeTarget) : deux couples de surfaces de travail. */
  readonly hazeCanvases = {
    fine: [document.createElement("canvas"), document.createElement("canvas")] as const,
    large: [document.createElement("canvas"), document.createElement("canvas")] as const,
  };
  haze: HazeTarget | undefined = undefined;
  readonly audio = new AudioEngine();

  view: TrackView | null = null;
  plan: ShowPlan | null = null;
  settings: RenderSettings = { ...DEFAULT_SETTINGS };
  session: Session | null = null;
  jobId = "";
  limits: Limits | null = null;
  analysisController: AbortController | null = null;
  /** Numéro de la résolution en cours : incrémenté à chaque nouvelle demande. */
  resolveSeq = 0;
  /** Vrai quand la résolution en cours suit le lecteur (et non une action manuelle). */
  autoResolving = false;
  pendingAnalysis: Analysis | null = null;
  pendingTitle = "";
  lastAutoTrackKey = "";
  nowPlaying: NowPlayingResponse | null = null;
  liveCapture: EventSource | null = null;
  liveRaf = 0;
  liveLevels: Record<string, number> = {};
  liveAudioRaw: LiveAudioFeatures = EMPTY_LIVE_AUDIO;
  liveAudio: LiveAudioFeatures = EMPTY_LIVE_AUDIO;
  liveView: TrackView | null = null;
  livePlan: ShowPlan | null = null;

  syncedView: TrackView | null = null;
  syncedPlan: ShowPlan | null = null;
  syncedStartMs = 0;
  syncedStartedAtEpoch = 0;
  syncedRaf = 0;
  syncedTimer: number | null = null;
  syncedLatencyMs = Number(localStorage.getItem("night-light-latency") ?? 0);
  /** Écart en cours de rattrapage, en millisecondes (0 si aucun). */
  syncDriftMs = 0;
  syncCorrectionStart = 0;
  syncCorrectionDur = 400;
  syncedMode = false;
  debugOverlayActive = false;
  /** Début (performance.now) de la transition en cours, 0 si aucune. */
  transitionStart = 0;
  transitionDuration = 1500;
  liveMode = true;
  liveTimeStart = performance.now();
  liveQuality = 1;
  liveQualityHold = 0;
  liveFrame = 0;
  liveMainRaf = 0;
  liveFps = 60;
  liveLastTs = 0;

  /* ---- debug ---- */
  readonly debugCapture: CaptureDebug = {
    link: "fermé",
    messages: 0,
    lastAt: 0,
    rate: 0,
    state: "inactive",
    active: "?",
    source: "",
    error: "",
  };
  readonly debugSync: SyncDebug = {
    phase: "LIVE",
    source: "",
    playerTitle: "",
    expectedTitle: "",
    playerMs: 0,
    showMs: 0,
    driftMs: 0,
    latencyMs: Number(localStorage.getItem("night-light-latency") ?? 0),
    attempts: 0,
    match: "",
    correlation: null,
    resyncAt: 0,
  };
  debugTimer: number | null = null;
  debugLastPlayer: ExternalPlaybackState | null = null;

  /* ---- lien avec le dashboard ---- */
  control: ControlLink | null = null;
  /** Dernier signe de vie du dashboard, en millisecondes epoch. */
  controllerAt = 0;
  controlTimer: number | null = null;
  flashSlider = 0.9;
  noflash = false;
  lastError: { title: string; message: string; detail: string } | null = null;
  /** Avis discret affiché en bas, sans jamais prendre l'écran. */
  notice: { text: string; at: number } | null = null;
  noticeTimer: number | null = null;
  debugRateWindowAt = 0;
  debugRateWindowCount = 0;
  debugLastSseState = "";

  rafId = 0;
  frame = 0;
  lastTs = 0;
  fps = 60;
  quality = 1;
  /** Images consécutives passées à demander un autre palier de qualité. */
  qualityHold = 0;
  /** Tranche de qualité courante : pilote la résolution du canvas. */
  qualityBand = false;
  lastHudUpdate = 0;
  seeking = false;
  reducedMotion = false;
  mediaQuery: MediaQueryList | null = null;

  constructor() {
    const canvas = el<HTMLCanvasElement>("stage");
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx === null) throw new Error("Canvas 2D indisponible dans ce navigateur.");
    this.canvas = canvas;
    this.ctx = ctx;
    this.mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = this.mediaQuery.matches;
    this.mediaQuery.addEventListener("change", this.onReducedMotionChange);
    this.bindDrop();
    this.bindResolve();
    this.bindLiveCapture();
    this.bindLatencyControls();
    showScreen("drop");
    void this.startLiveMode();
    window.setInterval(() => void this.pollNowPlaying(), 1500);
    void this.pollNowPlaying();
    this.bindAnalysis();
    this.bindShow();
    this.bindKeyboard();
    this.bindDebugToggle();
    this.debugTimer = window.setInterval(() => this.updateDebugOverlay(), 500);
    this.bindControl();
    window.addEventListener("resize", this.resize);
    this.resize();
    void this.loadHealth();
  }

  /* ------------------------------------------------------------ cycle de vie */

  private async loadHealth(): Promise<void> {
    try {
      const health = await fetchHealth();
      this.limits = {
        maxFileBytes: health.limits.maxFileBytes,
        maxDurationSec: health.limits.maxDurationSec,
      };
      dbgLog("boot", "prêt · limites", {
        maxMo: Math.round(health.limits.maxFileBytes / 1048576),
        maxDureeSec: health.limits.maxDurationSec,
      });
    } catch (error) {
      this.limits = null;
      dbgLog("erreur", "health injoignable", error instanceof Error ? error.message : String(error));
    }
  }

  dispose(): void {
    this.mediaQuery?.removeEventListener("change", this.onReducedMotionChange);
    window.removeEventListener("resize", this.resize);
    if (this.debugTimer !== null) window.clearInterval(this.debugTimer);
    this.debugTimer = null;
    if (this.controlTimer !== null) window.clearInterval(this.controlTimer);
    this.controlTimer = null;
    this.control?.close();
    this.control = null;
    this.stopLoop();
    this.audio.dispose();
  }

  /** Écrit une ligne dans la console et dans le tampon de l'overlay. */
  debug(category: DebugCategory, message: string, data?: unknown): void {
    dbgLog(category, message, data);
  }

  /** Repasse au mode direct et à l'écran de dépôt. */
  backToDrop(): void {
    this.stopLoop();
    this.audio.pause();
    void this.releaseSession();
    this.stopSyncedMode();
    this.liveMode = true;
    this.debug("live", "retour au mode live");
    this.bindLatencyControls();
    void this.startLiveMode();
    el<HTMLButtonElement>("btn-cancel-analysis").hidden = false;
    setUploadState({ phase: "Préparation", progress: 0, detail: "Envoi du fichier…" });
    el<HTMLElement>("dock-panel").classList.remove("is-hidden");
    delete document.body.dataset.analysisReady;
    showScreen("drop");
    setStatus("Écran de dépôt. Dépose un morceau pour lancer un spectacle.");
  }

  private onReducedMotionChange = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
    if (this.reducedMotion) {
      el<HTMLInputElement>("chk-reduced").checked = true;
      this.settings.reduced = true;
    }
    this.refreshPlan();
  };

  resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality < 0.5 ? 1.25 : 2);
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
  };
}

// Greffe les méthodes de chaque domaine sur le prototype, avant toute création.
installDrop(App);
installResolve(App);
installLive(App);
installSync(App);
installShow(App);
installControl(App);
installLoop(App);
