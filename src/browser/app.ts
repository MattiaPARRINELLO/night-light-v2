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
 *   - `app-effects`  effet forcé depuis le studio, par-dessus tous les modes
 *   - `app-loop`     boucle de rendu, qualité, nappes de fumée, transitions, HUD
 *   - `app-transition` fondus entre le direct et le show (entrée, sortie, réorientation)
 *
 * L'état vit ici pour rester la source de vérité unique ; la logique vit dans
 * des fichiers courts et lisibles.
 */

import { AudioEngine } from "./audio";
import { fetchHealth, type Limits, type NowPlayingResponse } from "../core/api";
import { dbgLog, type DebugCategory } from "../core/debug";
import type { HazeTarget } from "../core/families";
import { EMPTY_LIVE_AUDIO, type LiveAudioFeatures } from "../core/liveAudio";
import { EMPTY_LIVE_MUSIC, LiveDirector, type LiveMusic } from "../core/liveDirector";
import type { AutoResolveFailure } from "../core/nowPlaying";
import type { ExternalPlaybackState } from "../core/playback";
import { renderPixelRatio } from "../core/series";
import type { ShowPlan } from "../core/show";
import type { TrackView } from "../core/view";
import type { EffectTimeline } from "../core/effects";
import { ControlLink, type EffectOverride, type TrackTimings } from "../shared/control";
import { DEFAULT_SETTINGS, type Analysis, type RenderSettings } from "../types";
import { el, setStatus, setUploadState, showScreen } from "./ui";

import { installControl } from "./app-control";
import { installDrop } from "./app-drop";
import { installEffects } from "./app-effects";
import { installLive } from "./app-live";
import { installLoop } from "./app-loop";
import { installResolve } from "./app-resolve";
import { installShow } from "./app-show";
import { installSync } from "./app-sync";
import { installTransition } from "./app-transition";

interface Session {
  jobId: string;
  title: string;
  duration: number;
  startedAt: number;
}

export type TransitionMode = "black" | "crossfade";

/** Couche d'image que peut faire entrer ou sortir un fondu. */
export type FadeLayer = "live" | "show";

/**
 * Fondu entre deux couches.
 *
 * `from` peut être une couche encore rendue (`live`/`show`) ou une copie figée
 * (`snapshot`) : c'est ce qui permet de réorienter un fondu déjà en cours sans
 * couper l'image affichée.
 */
export interface CrossfadeState {
  active: boolean;
  startedAt: number;
  durationMs: number;
  from: FadeLayer | "snapshot";
  to: FadeLayer;
  fromCanvas: HTMLCanvasElement;
  fromCtx: CanvasRenderingContext2D;
  toCanvas: HTMLCanvasElement;
  toCtx: CanvasRenderingContext2D;
  /**
   * Ancien plan à continuer d'animer pendant un fondu de profil.
   * `null` pour les fondus direct/show classiques.
   */
  fromPlan: ShowPlan | null;
  timer: number | null;
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
  /** Instant musical (s) de la prochaine bascule standard ↔ rave. */
  pendingPlanAt: number | null = null;
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
  /**
   * Dernier échec automatique (durée annoncée comprise). Si le lecteur corrige
   * ensuite la durée du même morceau, la résolution est réarmée au lieu de
   * rester bloquée jusqu'au morceau suivant.
   */
  lastAutoFailure: AutoResolveFailure | null = null;
  /** Relance programmée après un échec passager d'une récupération automatique. */
  autoRetryTimer: number | null = null;
  /** Morceau concerné par la relance programmée. */
  autoRetryKey = "";
  /** Nombre de relances déjà programmées pour ce morceau. */
  autoRetryAttempt = 0;
  /** Nature de la relance en cours : panne passagère ou morceau non reconnu. */
  autoRetryUnrecognized = false;
  /**
   * Résolution automatique différée : le lecteur publie parfois le nouveau
   * titre avant la durée. Attendre que les métadonnées se stabilisent évite de
   * lancer une résolution avec la durée du morceau précédent.
   */
  autoResolveTimer: number | null = null;
  nowPlaying: NowPlayingResponse | null = null;
  nowPlayingStream: EventSource | null = null;
  nowPlayingPollTimer: number | null = null;
  nowPlayingWatchdog: number | null = null;
  nowPlayingLastEventAt = 0;
  /** Dernière piste détectée, pour ne pas réinitialiser la chronologie en boucle. */
  lastDetectedKey = "";
  liveCapture: EventSource | null = null;
  liveRaf = 0;
  liveLevels: Record<string, number> = {};
  liveAudioRaw: LiveAudioFeatures = EMPTY_LIVE_AUDIO;
  liveAudio: LiveAudioFeatures = EMPTY_LIVE_AUDIO;
  /** Horodatage local du dernier message reçu, pour détecter une capture muette. */
  liveAudioSeenAt = 0;
  /** Direction musicale du direct : temps forts, impacts, montées. */
  liveDirector = new LiveDirector();
  liveMusic: LiveMusic = EMPTY_LIVE_MUSIC;
  liveView: TrackView | null = null;
  livePlan: ShowPlan | null = null;

  /**
   * Effet forcé depuis le studio : il prend le pas sur le show en cours, quel
   * que soit le mode (direct, synchronisé ou show local).
   */
  effectOverride: EffectOverride | null = null;
  effectTimeline: EffectTimeline | null = null;
  effectStartMs = 0;
  effectFrame = 0;

  syncedView: TrackView | null = null;
  syncedPlan: ShowPlan | null = null;
  /**
   * Titre du morceau que le show synchronisé affiche réellement.
   *
   * `pendingTitle` suit le lecteur et change dès qu'un nouveau morceau est
   * détecté, avant même que son analyse soit prête. Comparer le lecteur à
   * `pendingTitle` faisait donc croire que tout était en ordre pendant que
   * l'ancien spectacle tournait encore, et la resynchronisation le recalait sur
   * la position du nouveau morceau : l'ancien show repartait de son début.
   */
  syncedTitle = "";
  /** Analyse finale en attente : on garde la scène courante jusqu'à sa fin. */
  pendingSynced: { view: TrackView; plan: ShowPlan; switchAt: number } | null = null;
  syncedStartMs = 0;
  syncedStartedAtEpoch = 0;
  syncedRaf = 0;
  syncedTimer: number | null = null;
  syncedLatencyMs = Number(localStorage.getItem("night-light-latency") ?? 0);
  /** Vrai quand le lecteur est en pause : le temps du show reste figé. */
  syncedPaused = false;
  /** Numéro de la tentative de calage courante : une nouvelle remplace l'ancienne. */
  syncAttemptSeq = 0;
  /** Écart en cours de rattrapage, en millisecondes (0 si aucun). */
  syncDriftMs = 0;
  syncCorrectionStart = 0;
  syncCorrectionDur = 400;
  syncedMode = false;
  /** Mode d'entrée dans le show : voile noir historique ou fondu enchaîné. */
  transitionMode: TransitionMode =
    localStorage.getItem("night-light-transition") === "black" ? "black" : "crossfade";
  crossfade: CrossfadeState | null = null;
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
  /** Échec de résolution automatique, publié uniquement vers le dashboard. */
  resolveFailure: { title: string; artist: string; detail: string; at: number } | null = null;
  /** Chronologie du morceau en cours, du lecteur au premier frame. */
  trackTimings: TrackTimings | null = null;
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
  lastHudUpdate = 0;
  seeking = false;
  reducedMotion = false;
  mediaQuery: MediaQueryList | null = null;
  /** Dernière surface CSS rendue, pour distinguer un redimensionnement de fenêtre d'un changement de palier. */
  private lastCssWidth = 0;
  private lastCssHeight = 0;

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
    this.bindNowPlayingStream();
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
    this.stopNowPlayingPolling();
    this.cancelScheduledAutoResolve();
    this.nowPlayingStream?.close();
    this.nowPlayingStream = null;
    if (this.nowPlayingWatchdog !== null) window.clearInterval(this.nowPlayingWatchdog);
    this.nowPlayingWatchdog = null;
    if (this.crossfade?.timer != null) window.clearTimeout(this.crossfade.timer);
    this.crossfade = null;
    this.stopLoop();
    this.audio.dispose();
  }

  /** Écrit une ligne dans la console et dans le tampon de l'overlay. */
  debug(category: DebugCategory, message: string, data?: unknown): void {
    dbgLog(category, message, data);
  }

  /**
   * Repasse au mode direct et à l'écran de dépôt.
   *
   * `fade` fait sortir le show en fondu vers le direct au lieu de couper net :
   * la dernière image du spectacle est figée puis dissoute dans l'ambiance
   * live. C'est le passage utilisé à la fin d'un morceau et au changement de
   * piste ; les retours manuels (erreur, choix de morceau) restent instantanés.
   */
  backToDrop(options: { fade?: boolean; reason?: string } = {}): void {
    // Copie de l'image AVANT tout arrêt : c'est elle qui portera le fondu.
    const sortie = options.fade === true && this.syncedMode ? this.snapshot() : null;
    this.stopSyncedMode();
    this.stopLoop();
    this.audio.pause();
    void this.releaseSession();
    this.liveMode = true;
    this.debug("live", "retour au mode live", {
      raison: options.reason ?? "manuel",
      fondu: sortie !== null,
    });
    this.bindLatencyControls();
    // Le fondu doit exister avant le premier rendu live, sinon celui-ci peint
    // directement sur la toile et la sortie n'a plus d'image à dissoudre.
    if (sortie !== null) this.createCrossfade("snapshot", "live", 2200, { source: sortie });
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
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    // Pendant le mode direct, le spectacle n'est qu'une ambiance derrière
    // l'écran de dépôt : on la rend plus petite, elle est floue de toute façon et
    // c'est elle qui saturait le fil principal au démarrage. Un show calé ou un
    // show local qui se prépare pendant le fondu n'est pas une ambiance : il
    // garde sa finesse, même si les deux boucles tournent encore.
    const ambient = this.liveMode && !this.syncedMode && this.view === null ? 0.7 : 1;
    const quality = this.liveMode && this.view === null ? this.liveQuality : this.quality;
    const ratio = renderPixelRatio(quality, width, height, window.devicePixelRatio || 1) * ambient;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (this.canvas.width === pixelWidth && this.canvas.height === pixelHeight) return;
    // Redimensionner un canvas efface son contenu : sans reprise, un changement
    // de palier en plein spectacle faisait clignoter une image noire. On garde
    // donc l'image courante et on la repose, mise à l'échelle, aussitôt.
    // Seulement quand la fenêtre ne bouge pas : pendant un redimensionnement,
    // l'image est de toute façon recalculée à chaque mouvement et la copie
    // coûterait plus cher que le défaut.
    const sameSurface = this.lastCssWidth === width && this.lastCssHeight === height;
    this.lastCssWidth = width;
    this.lastCssHeight = height;
    const previous = sameSurface && this.canvas.width > 1 && this.canvas.height > 1 ? this.snapshot() : null;
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    if (previous !== null) {
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.globalAlpha = 1;
      this.ctx.drawImage(previous, 0, 0, pixelWidth, pixelHeight);
      this.ctx.restore();
    }
    // Un fondu en cours rend hors écran : ses deux surfaces doivent suivre la
    // même taille, sinon ses couches se retrouvent dans un coin de l'image.
    if (this.crossfade !== null) this.resizeCrossfade();
  };

  /** Copie de l'image affichée, pour la conserver à travers un redimensionnement ou un fondu. */
  snapshot(): HTMLCanvasElement | null {
    try {
      const copy = document.createElement("canvas");
      copy.width = this.canvas.width;
      copy.height = this.canvas.height;
      const ctx = copy.getContext("2d");
      if (ctx === null) return null;
      ctx.drawImage(this.canvas, 0, 0);
      return copy;
    } catch {
      return null;
    }
  }
}

// Greffe les méthodes de chaque domaine sur le prototype, avant toute création.
installDrop(App);
installResolve(App);
installLive(App);
installSync(App);
installShow(App);
installControl(App);
installEffects(App);
installLoop(App);
installTransition(App);
