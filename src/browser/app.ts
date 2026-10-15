import { AudioEngine } from "./audio";
import { ApiError, audioUrl, fetchHealth, fetchNowPlaying, fetchPlaybackPosition, resolveAndAnalyze, uploadAndAnalyze, type Limits, type NowPlayingResponse, type PlaybackPositionResponse } from "../core/api";
import {
  FAMILY_LABELS,
  MOOD_LABELS,
  SCENE_REASON_LABELS,
  buildShowPlan,
  sceneAt,
  type ShowPlan,
} from "../core/show";
import { drawTransition, renderFrame, sceneHue, variationStrength } from "../core/render";
import { clamp, formatTime, quantizeQuality } from "../core/series";
import {
  EMPTY_LIVE_AUDIO,
  normalizeLiveLevels,
  smoothLiveFeatures,
  type LiveAudioFeatures,
} from "../core/liveAudio";
import { TrackView } from "../core/view";
import { estimatePlayerPositionMs, normalizePlaybackText, showDriftMs, syncCorrection } from "../core/playback";
import type { ExternalPlaybackState } from "../core/playback";
import { dbgLog, dbgThrottled, debugLog, type DebugCategory } from "../core/debug";
import { ControlLink, type DashboardCommand, type ShowMode, type ShowState } from "../shared/control";
import type { Analysis, RenderSettings } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { el, setDropError, setPlaying, setShowError, setStatus, setUploadState, showScreen } from "./ui";
import { clamp01 } from "../core/series";

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|weba|webm)$/i;

/**
 * Nombre d'images pendant lesquelles un palier de qualité doit être demandé
 * avant d'être adopté. Sans ce délai, un fps qui oscille autour d'une frontière
 * fait basculer le rendu d'un palier à l'autre en permanence.
 */
const QUALITY_HOLD_FRAMES = 24;
const SECTION_LABELS: Record<string, string> = {
  calme: "Passage calme",
  montee: "Montée",
  intense: "Impact",
  descente: "Descente",
  silence: "Silence",
};

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

function num(value: number | undefined): string {
  return Number.isFinite(value) ? (value as number).toFixed(3) : "—";
}

function seconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return `${(ms / 1000).toFixed(2)} s`;
}

export class App {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly audio = new AudioEngine();

  private view: TrackView | null = null;
  private plan: ShowPlan | null = null;
  private settings: RenderSettings = { ...DEFAULT_SETTINGS };
  private session: Session | null = null;
  private jobId = "";
  private limits: Limits | null = null;
  private analysisController: AbortController | null = null;
  private pendingAnalysis: Analysis | null = null;
  private pendingTitle = "";
  private lastAutoTrackKey = "";
  private nowPlaying: NowPlayingResponse | null = null;
  private liveCapture: EventSource | null = null;
  private liveRaf = 0;
  private liveLevels: Record<string, number> = {};
  private liveAudioRaw: LiveAudioFeatures = EMPTY_LIVE_AUDIO;
  private liveAudio: LiveAudioFeatures = EMPTY_LIVE_AUDIO;
  private liveView: TrackView | null = null;
  private livePlan: ShowPlan | null = null;

  private syncedView: TrackView | null = null;
  private syncedPlan: ShowPlan | null = null;
  private syncedStartMs = 0;
  private syncedStartedAtEpoch = 0;
  private syncedRaf = 0;
  private syncedTimer: number | null = null;
  private syncedLatencyMs = Number(localStorage.getItem("night-light-latency") ?? 0);
  private syncedMode = false;
  private debugOverlayActive = false;
  /** Début (performance.now) de la transition en cours, 0 si aucune. */
  private transitionStart = 0;
  private transitionDuration = 1500;
  private liveMode = true;
  private liveTimeStart = performance.now();
  private liveQuality = 1;
  private liveQualityHold = 0;
  private liveFrame = 0;
  private liveMainRaf = 0;
  private liveFps = 60;
  private liveLastTs = 0;

  /* ---- debug ---- */
  private readonly debugCapture: CaptureDebug = {
    link: "fermé",
    messages: 0,
    lastAt: 0,
    rate: 0,
    state: "inactive",
    active: "?",
    source: "",
    error: "",
  };
  private readonly debugSync: SyncDebug = {
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
  private debugTimer: number | null = null;
  private debugLastPlayer: ExternalPlaybackState | null = null;

  /* ---- lien avec le dashboard ---- */
  private control: ControlLink | null = null;
  /** Dernier signe de vie du dashboard, en millisecondes epoch. */
  private controllerAt = 0;
  private controlTimer: number | null = null;
  private flashSlider = 0.9;
  private noflash = false;
  private lastError: { title: string; message: string; detail: string } | null = null;
  /** Avis discret affiché en bas, sans jamais prendre l'écran. */
  private notice: { text: string; at: number } | null = null;
  private noticeTimer: number | null = null;
  private debugRateWindowAt = 0;
  private debugRateWindowCount = 0;
  private debugLastSseState = "";

  private rafId = 0;
  private frame = 0;
  private lastTs = 0;
  private fps = 60;
  private quality = 1;
  /** Images consécutives passées à demander un autre palier de qualité. */
  private qualityHold = 0;
  /** Tranche de qualité courante : pilote la résolution du canvas. */
  private qualityBand = false;
  private lastHudUpdate = 0;
  private seeking = false;
  private reducedMotion = false;
  private mediaQuery: MediaQueryList | null = null;

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

  /* ------------------------------------------------------------------- dépôt */

  private bindDrop(): void {
    const zone = el<HTMLElement>("dropzone");
    const input = el<HTMLInputElement>("file-input");
    let depth = 0;

    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file !== undefined) void this.handleFile(file);
      input.value = "";
    });

    const stop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    zone.addEventListener("dragenter", (event) => {
      stop(event);
      depth += 1;
      zone.classList.add("is-dragover");
    });
    zone.addEventListener("dragover", (event) => {
      stop(event);
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
      zone.classList.add("is-dragover");
    });
    zone.addEventListener("dragleave", (event) => {
      stop(event);
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        zone.classList.remove("is-dragover");
      }
    });
    zone.addEventListener("drop", (event) => {
      stop(event);
      depth = 0;
      zone.classList.remove("is-dragover");
      const file = event.dataTransfer?.files?.[0];
      if (file !== undefined) void this.handleFile(file);
    });

    // Empêche le navigateur d'ouvrir un fichier lâché hors zone.
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
  }

  private async handleFile(file: File): Promise<void> {
    setDropError(null);
    if (this.limits !== null && file.size > this.limits.maxFileBytes) {
      setDropError(
        `Fichier trop volumineux (${(file.size / 1048576).toFixed(1)} Mo). Limite : ${(
          this.limits.maxFileBytes / 1048576
        ).toFixed(0)} Mo.`,
      );
      return;
    }
    if (file.size === 0) {
      setDropError("Ce fichier est vide.");
      return;
    }
    const looksAudio =
      file.type.startsWith("audio/") || file.type === "video/mp4" || AUDIO_EXTENSIONS.test(file.name);
    if (!looksAudio) {
      setDropError("Format non reconnu. Dépose un MP3, WAV, OGG, FLAC ou M4A.");
      return;
    }

    const title = file.name.replace(/\.[^.]+$/, "");
    this.pendingTitle = title;
    this.pendingAnalysis = null;
    el<HTMLElement>("dock-panel").classList.add("is-hidden");
    setUploadState({
      phase: "Envoi",
      progress: 0,
      detail: `${(file.size / 1048576).toFixed(1)} Mo — le fichier part vers le serveur local`,
      title,
      meta: "Analyse audio en approche",
    });

    const controller = new AbortController();
    this.analysisController = controller;
    this.debug("analyse", `fichier déposé · ${title}`, {
      tailleMo: Number((file.size / 1048576).toFixed(1)),
      type: file.type || "inconnu",
    });
    try {
      const { jobId, analysis } = await uploadAndAnalyze(file, {
        signal: controller.signal,
        onUploadProgress: (ratio) => {
          setUploadState({
            phase: "Envoi",
            progress: ratio * 0.25,
            detail: `${Math.round(ratio * 100)} % envoyé`,
          });
          dbgThrottled("upload", "analyse", "envoi vers le serveur", { progression: `${Math.round(ratio * 100)} %` }, 2000);        },
        onPhase: ({ progress, phase, detail }) => {
          setUploadState({
            phase,
            progress: 0.25 + progress * 0.75,
            detail: detail.length > 0 ? detail : phase,
          });
        },
      });
      this.jobId = jobId;
      this.pendingAnalysis = analysis;
      document.body.dataset.analysisReady = "true";
      this.debug("analyse", "analyse terminée", {
        titre: title,
        dureeSec: Number(analysis.duration.toFixed(1)),
        tempo: Number(analysis.tempo.toFixed(1)),
        temps: analysis.beats.length,
        montees: analysis.builds.length,
        sections: analysis.sections.length,
      });
      void this.tryAutoSynced(title, "", analysis.duration, analysis);
    } catch (error) {
      if (error instanceof ApiError && error.code === "aborted") {
        this.debug("analyse", "analyse annulée par l'utilisateur");
        this.backToDrop();
        return;
      }
      const message = error instanceof Error ? error.message : "Erreur inconnue pendant l'analyse.";
      const detail =
        error instanceof ApiError ? `${error.code}${error.detail ? ` — ${error.detail}` : ""}` : String(error);
      this.debug("erreur", "analyse en échec", { message, detail });
      setShowError("L'analyse a échoué", message, detail);
      showScreen("error");
    } finally {
      this.analysisController = null;
    }
  }

  /**
   * Morceau non reconnu côté lecteur : ce n'est pas une erreur, c'est un repli.
   * On repasse en direct — qui réagit au son — et on se contente d'un avis
   * discret, plutôt que d'un écran d'erreur qui prend toute la salle.
   */
  private fallbackToLive(title: string, reason: string): void {
    this.debugSync.phase = "LOST";
    this.debugSync.match = reason;
    this.setNotice(`« ${title} » non reconnu — synchronisation sur le son en direct`);
    this.debug("attention", `morceau « ${title} » non reconnu · repli sur le direct`, reason);
    this.lastError = null;
    this.backToDrop();
  }

  /** Avis discret en bas d'écran, jamais un écran d'erreur. */
  private setNotice(text: string): void {
    this.notice = { text, at: Date.now() };
    const node = document.getElementById("notice");
    if (node !== null) {
      node.textContent = text;
      node.hidden = false;
    }
    // L'avis s'efface tout seul : il informe, il ne s'installe pas. Le dashboard
    // garde l'information tant qu'un nouveau morceau n'a pas été reconnu.
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      const bar = document.getElementById("notice");
      if (bar !== null) bar.hidden = true;
    }, 12000);
  }

  private clearNotice(): void {
    this.notice = null;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    const node = document.getElementById("notice");
    if (node !== null) {
      node.textContent = "";
      node.hidden = true;
    }
  }

  private bindAnalysis(): void {
    el<HTMLButtonElement>("btn-cancel-analysis").addEventListener("click", () => {
      this.analysisController?.abort();
      this.backToDrop();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.analysisController !== null) {
        this.analysisController.abort();
        this.backToDrop();
      }
    });
    el<HTMLButtonElement>("btn-error-back").addEventListener("click", () => {
      this.backToDrop();
    });
  }

  private bindResolve(): void {
    const form = el<HTMLFormElement>("resolve-form");
    const status = el<HTMLElement>("resolve-status");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.analysisController !== null) return;
      const title = el<HTMLInputElement>("resolve-title").value.trim();
      const artist = el<HTMLInputElement>("resolve-artist").value.trim();
      const rawDuration = el<HTMLInputElement>("resolve-duration").value.trim();
      const duration = rawDuration === "" ? undefined : Number(rawDuration);
      if (title === "" || artist === "") {
        status.hidden = false;
        status.classList.add("is-error");
        status.textContent = "Le titre et l'artiste sont requis.";
        return;
      }
      if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) {
        status.hidden = false;
        status.classList.add("is-error");
        status.textContent = "La durée doit être un nombre positif.";
        return;
      }
      status.hidden = false;
      status.classList.remove("is-error");
      status.textContent = "Recherche en cours…";
      void this.handleResolve(title, artist, duration);
    });
  }

  private async handleResolve(title: string, artist: string, duration: number | undefined, trackKey?: string): Promise<void> {
    const status = el<HTMLElement>("resolve-status");
    const controller = new AbortController();
    this.analysisController = controller;
    this.pendingTitle = title;
    this.pendingAnalysis = null;
    el<HTMLElement>("dock-panel").classList.add("is-hidden");
    this.debug("analyse", `recherche par titre · ${title} / ${artist}`, { dureeSec: duration ?? "—" });
    setUploadState({
      phase: "Recherche",
      progress: 0,
      detail: "Recherche du morceau sur YouTube",
      title,
      meta: "Résolution automatique",
    });
    try {
      const { jobId, analysis } = await resolveAndAnalyze(
        title,
        artist,
        duration,
        {
          signal: controller.signal,
          onPhase: ({ progress, phase, detail }) => {
            setUploadState({ phase, progress, detail: detail.length > 0 ? detail : phase, title });
            dbgThrottled(
              `phase-${phase}`,
              "analyse",
              `phase « ${phase} »`,
              {
                progression: `${Math.round(progress * 100)} %`,
                detail: detail.length > 0 ? detail : phase,
              },
              4000,
            );
          },
        },
        trackKey,
      );
      this.jobId = jobId;
      this.pendingAnalysis = analysis;
      document.body.dataset.analysisReady = "true";
      this.debug("analyse", `analyse terminée · ${title} / ${artist}`, {
        dureeSec: Number(analysis.duration.toFixed(1)),
        tempo: Number(analysis.tempo.toFixed(1)),
        temps: analysis.beats.length,
        montees: analysis.builds.length,
        sections: analysis.sections.length,
      });
      void this.tryAutoSynced(title, artist, analysis.duration, analysis);
      status.hidden = true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "aborted") {
        this.debug("analyse", "recherche annulée par l'utilisateur");
        this.backToDrop();
        return;
      }
      const message = error instanceof Error ? error.message : "Erreur inconnue pendant la résolution.";
      const detail =
        error instanceof ApiError ? `${error.code}${error.detail ? ` — ${error.detail}` : ""}` : String(error);
      // Une résolution automatique qui échoue est une situation normale (le
      // morceau peut ne pas être sur Deezer) : ce n'est pas une erreur.
      this.debug("attention", "morceau non récupéré automatiquement", { message, detail });
      setShowError("Le morceau n'a pas pu être récupéré", message, detail);
      showScreen("error");
      status.hidden = false;
      status.classList.add("is-error");
      status.textContent = message;
    } finally {
      this.analysisController = null;
    }
  }

  private async pollNowPlaying(): Promise<void> {
    try {
      const data = await fetchNowPlaying();
      this.nowPlaying = data;
      this.updateNowPlayingUI();
      dbgThrottled(
        "now-playing",
        "sync",
        "lecteur scruté",
        {
          source: data.available ? "détecté" : "aucun",
          titre: data.title || "—",
          artiste: data.artist || "—",
          statut: data.status,
          positionSec: data.positionSec === null || data.positionSec === undefined ? "—" : Number(data.positionSec.toFixed(1)),
          ambigue: data.ambiguous,
        },
        5000,
      );
      await this.maybeAutoResolve();
    } catch {
      // Service indisponible : on masque simplement l'indication.
      this.nowPlaying = null;
      const status = document.getElementById("resolve-detected");
      if (status !== null) status.hidden = true;
    }
  }

  private updateNowPlayingUI(): void {
    const status = document.getElementById("resolve-detected");
    if (status === null) return;
    const data = this.nowPlaying;
    if (data === null || !data.available || data.title === "" || data.artist === "") {
      status.hidden = true;
      return;
    }
    status.hidden = false;
    status.classList.remove("is-error");
    if (data.ambiguous) {
      status.textContent = "Plusieurs lecteurs détectés. Import manuel recommandé.";
      return;
    }
    status.textContent = `Lecteur détecté : ${data.title} — ${data.artist}${data.status === "playing" ? " (lecture)" : " (pause)"}`;
  }

  private async maybeAutoResolve(): Promise<void> {
    const data = this.nowPlaying;
    if (data === null || !data.available || data.ambiguous || data.status !== "playing") return;
    if (data.title.trim() === "" || data.artist.trim() === "") return;
    if (this.analysisController !== null) return;
    const key = `${data.title.trim()}|${data.artist.trim()}`;
    if (key === this.lastAutoTrackKey) return;
    this.lastAutoTrackKey = key;
    el<HTMLInputElement>("resolve-title").value = data.title;
    el<HTMLInputElement>("resolve-artist").value = data.artist;
    if (data.durationSec !== null && data.durationSec !== undefined && data.durationSec > 0) {
      el<HTMLInputElement>("resolve-duration").value = String(Math.round(data.durationSec));
    }
    await this.handleResolve(data.title, data.artist, data.durationSec ?? undefined, key);
  }

  private startLiveRender(): void {
    this.stopLiveRender();
    const canvas = el<HTMLCanvasElement>("live-stage");
    canvas.hidden = false;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);
    const loop = () => {
      this.liveRaf = requestAnimationFrame(loop);
      if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) resize();
      const w = canvas.width;
      const h = canvas.height;
      context.fillStyle = "rgba(0,0,0,0.18)";
      context.fillRect(0, 0, w, h);
      const rms = clamp01(Number(this.liveLevels.rms ?? 0));
      const energy = clamp01(Number(this.liveLevels.energy ?? rms));
      const bass = clamp01(Number(this.liveLevels.bass ?? 0.33));
      const mid = clamp01(Number(this.liveLevels.mid ?? 0.33));
      const high = clamp01(Number(this.liveLevels.high ?? 0.34));
      const transient = clamp01(Number(this.liveLevels.transient ?? 0));
      const bars = 48;
      for (let i = 0; i < bars; i++) {
        const section = i / bars;
        const tone = section < 0.33 ? bass : section < 0.66 ? mid : high;
        const barHeight = h * (0.08 + tone * 0.75 * energy) * (1 + transient * 0.35);
        const x = (i / bars) * w;
        const bw = w / bars - 4;
        context.fillStyle = `hsla(${200 + section * 120}, 80%, ${55 + tone * 35}%, ${0.5 + energy * 0.35})`;
        context.fillRect(x + 2, h - barHeight, bw, barHeight);
      }
      // Pulse central modulé par les basses.
      const radius = h * (0.08 + bass * 0.35 * energy);
      const gradient = context.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, radius);
      gradient.addColorStop(0, `rgba(255,255,255,${0.1 + transient * 0.25})`);
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(w / 2, h / 2, radius, 0, Math.PI * 2);
      context.fill();
    };
    loop();
  }

  private stopLiveRender(): void {
    if (this.liveRaf !== 0) cancelAnimationFrame(this.liveRaf);
    this.liveRaf = 0;
    const canvas = document.getElementById("live-stage");
    if (canvas instanceof HTMLCanvasElement) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.hidden = true;
    }
  }

  private bindLiveCapture(): void {
    el<HTMLButtonElement>("btn-live-capture").addEventListener("click", () => {
      if (this.liveCapture !== null) this.closeExternalCapture();
      else this.openExternalCapture();
    });
  }

  private openExternalCapture(): void {
    if (this.liveCapture !== null) return;
    const btn = el<HTMLButtonElement>("btn-live-capture");
    const level = el<HTMLElement>("live-level");
    const source = new EventSource("/api/audio-levels");
    this.debugCapture.link = "connexion…";
    this.debug("capture", "ouverture du flux SSE /api/audio-levels");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        this.liveLevels = data as Record<string, number>;
        const now = performance.now();
        this.debugCapture.messages += 1;
        this.debugCapture.lastAt = Date.now();
        this.debugRateWindowCount += 1;
        if (this.debugRateWindowAt === 0) this.debugRateWindowAt = now;
        if (now - this.debugRateWindowAt >= 1000) {
          this.debugCapture.rate = (this.debugRateWindowCount * 1000) / (now - this.debugRateWindowAt);
          this.debugRateWindowAt = now;
          this.debugRateWindowCount = 0;
        }
        this.debugCapture.link = "ouvert";
        this.debugCapture.state = String(data.state ?? "inactive");
        this.debugCapture.active = String(data.active ?? "?");
        this.debugCapture.source = String(data.source ?? "");
        this.debugCapture.error = String(data.error ?? "");
        if (this.debugCapture.error !== "") this.debug("erreur", "capture en erreur", this.debugCapture.error);
        if (this.debugCapture.state !== this.debugLastSseState) {
          this.debug("capture", `état de la capture → ${this.debugCapture.state}`, {
            source: this.debugCapture.source,
            rms: Number(data.rms ?? 0).toFixed(4),
          });
          this.debugLastSseState = this.debugCapture.state;
        }
        const next = normalizeLiveLevels(data);
        this.liveAudioRaw = next;
        if (data.error) {
          level.textContent = String(data.error);
          return;
        }
        const percent = Math.round((Number(data.rms ?? 0)) * 100);
        level.textContent = `Capture ${data.state ?? (data.active ? "active" : "inactive")} · niveau ${percent} %`;
        dbgThrottled(
          "levels",
          "capture",
          "caractéristiques reçues",
          {
            rms: next.rms.toFixed(3),
            energie: next.energy.toFixed(3),
            basses: next.bass.toFixed(2),
            mediums: next.mid.toFixed(2),
            aigus: next.high.toFixed(2),
            transitoire: next.transient.toFixed(3),
          },
          1000,
        );
      } catch {
        /* ignore malformed event */
      }
    };
    source.onerror = () => {
      level.textContent = "Erreur de capture audio";
      this.debugCapture.link = "erreur";
      this.debug("erreur", "flux SSE de capture interrompu (parec ou serveur)");
    };
    this.liveCapture = source;
    btn.textContent = "Arrêter la capture";
    level.textContent = "Capture en cours…";
    // Le visualiseur en barres n'a de sens qu'en mode live : pendant un show,
    // il se superposerait au spectacle. La capture, elle, doit continuer —
    // l'audio vient du lecteur externe, pas du navigateur, donc pas de boucle.
    if (this.liveMode) this.startLiveRender();
  }

  private closeExternalCapture(): void {
    if (this.liveCapture === null) return;
    this.liveCapture.close();
    this.liveCapture = null;
    const btn = el<HTMLButtonElement>("btn-live-capture");
    const level = el<HTMLElement>("live-level");
    btn.textContent = "Écouter le son du PC";
    level.textContent = "Capture inactive";
    this.debug("capture", `flux SSE fermé · ${this.debugCapture.messages} messages reçus au total`);
    this.debugCapture.link = "fermé";
    this.debugCapture.state = "fermée";
    this.debugCapture.active = "?";
    this.debugCapture.error = "";
    this.debugLastSseState = "";
    this.stopLiveRender();
  }

  private backToDrop(): void {
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



  private bindLatencyControls(): void {
    const input = document.getElementById("latency-offset") as HTMLInputElement | null;
    if (input === null) return;
    input.value = String(this.syncedLatencyMs);
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (Number.isFinite(value)) {
        this.syncedLatencyMs = Math.max(-500, Math.min(1000, value));
        localStorage.setItem("night-light-latency", String(this.syncedLatencyMs));
      }
    });
    document.getElementById("latency-preset-wired")?.addEventListener("click", () => {
      this.syncedLatencyMs = 0;
      input.value = "0";
      localStorage.setItem("night-light-latency", "0");
    });
    document.getElementById("latency-calibrate")?.addEventListener("click", () => { this.calibrateLatency(); });
    document.getElementById("latency-preset-bt")?.addEventListener("click", () => {
      this.syncedLatencyMs = 200;
      input.value = "200";
      localStorage.setItem("night-light-latency", "200");
    });
  }

  private bindDebugToggle(): void {
    window.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "d" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
        this.debugOverlayActive = !this.debugOverlayActive;
        const overlay = document.getElementById("debug-overlay");
        if (overlay !== null) overlay.toggleAttribute("hidden", !this.debugOverlayActive);
        this.debug("boot", `overlay de debug ${this.debugOverlayActive ? "affiché" : "masqué"}`);
      }
    });
  }

  /**
   * Concentre tout ce qui se passe en direct : mode courant, état de la capture
   * système, valeurs audio brutes et lissées, position du lecteur face à celle
   * du show, puis la fin du journal. Rafraîchi deux fois par seconde.
   */
  private updateDebugOverlay(): void {
    const overlay = document.getElementById("debug-overlay");
    if (overlay === null || !this.debugOverlayActive) return;

    const cap = this.debugCapture;
    const sync = this.debugSync;
    const age = cap.lastAt === 0 ? "jamais" : `${Math.max(0, Math.round(Date.now() - cap.lastAt))} ms`;
    const raw = this.liveAudioRaw;
    const smooth = this.liveAudio;

    const lines: string[] = [
      "── Night Light · debug (touche D pour masquer) ──",
      `mode            ${sync.phase} · live=${this.liveMode ? "oui" : "non"} · show=${this.syncedMode ? "sync" : this.view === null ? "—" : "local"}`,
      `capture         SSE ${cap.link} · ${cap.messages} messages · ${cap.rate.toFixed(1)}/s · dernier il y a ${age}`,
      `capture état    ${cap.state}${cap.active === "?" ? "" : ` · active=${cap.active}`}${cap.source === "" ? "" : ` · source=${cap.source}`}${cap.error === "" ? "" : ` · erreur=${cap.error}`}`,
      `audio brut      rms=${num(raw.rms)} én=${num(raw.energy)} basses=${num(raw.bass)} méd=${num(raw.mid)} aigus=${num(raw.high)} transitoire=${num(raw.transient)}`,
      `audio lissé     rms=${num(smooth.rms)} én=${num(smooth.energy)} basses=${num(smooth.bass)} méd=${num(smooth.mid)} aigus=${num(smooth.high)} transitoire=${num(smooth.transient)}`,
      `rendu live      fps=${this.liveFps.toFixed(1)} · qualité=${this.liveQuality.toFixed(2)} · ${this.liveFrame} images`,
      `rendu show      fps=${this.fps.toFixed(1)} · qualité=${this.quality.toFixed(2)} · ${this.frame} images`,
    ];

    if (sync.phase !== "LIVE") {
      // Valeurs recalculées à l'instant de l'affichage : entre deux resyncs
      // (2,5 s), le show et le lecteur continuent d'avancer.
      const joueur = this.debugLastPlayer;
      const maintenant = Date.now();
      const lecteurMs = joueur === null ? sync.playerMs : estimatePlayerPositionMs(joueur, maintenant);
      const showMs = this.syncedMode
        ? this.syncedStartMs + (maintenant - this.syncedStartedAtEpoch)
        : sync.showMs;
      const ecartMs =
        joueur === null ? sync.driftMs : lecteurMs + this.syncedLatencyMs - showMs;
      lines.push(
        `sync           source=${sync.source === "" ? "?" : sync.source} · attendu=${sync.expectedTitle === "" ? "—" : sync.expectedTitle}`,
        `sync morceau   lecteur=${sync.playerTitle === "" ? "—" : sync.playerTitle}`,
        `sync position  lecteur=${seconds(lecteurMs)} · show=${seconds(showMs)} · écart=${Math.round(ecartMs)} ms`,
        `sync réglages  latence=${sync.latencyMs} ms · tentatives=${sync.attempts} · corrélation=${sync.correlation === null ? "—" : sync.correlation.toFixed(2)}`,
        `sync verdict   ${sync.match === "" ? "—" : sync.match}${sync.resyncAt === 0 ? "" : ` · dernier contrôle il y a ${((performance.now() - sync.resyncAt) / 1000).toFixed(1)} s`}`,
      );
    }

    lines.push("── journal ──");
    for (const line of debugLog.lines(14, 6)) lines.push(line);
    overlay.textContent = lines.join("\n");
  }

  /** Écrit une ligne dans la console et dans le tampon de l'overlay. */
  private debug(category: DebugCategory, message: string, data?: unknown): void {
    dbgLog(category, message, data);
  }

  private calibrateLatency(): void {
    if (!this.syncedMode || this.syncedView === null) return;
    const time = (this.syncedStartMs + (Date.now() - this.syncedStartedAtEpoch)) / 1000;
    const beats = this.syncedView.beats;
    let nearestMs = Math.round(time * 1000);
    let diffMs = Number.POSITIVE_INFINITY;
    for (const beat of beats) {
      const d = Math.abs(beat * 1000 - Math.round(time * 1000));
      if (d < diffMs) {
        diffMs = d;
        nearestMs = Math.round(beat * 1000);
      }
    }
    this.syncedLatencyMs = Math.max(-500, Math.min(1000, nearestMs - Math.round(time * 1000)));
    const input = document.getElementById("latency-offset") as HTMLInputElement | null;
    if (input !== null) input.value = String(this.syncedLatencyMs);
    localStorage.setItem("night-light-latency", String(this.syncedLatencyMs));
  }

  /* ------------------------------------------------------- lien dashboard */

  /**
   * Ouvre le canal de contrôle. L'écran de show reste une application normale
   * quand il est ouvert seul (utile pour les tests et l'usage à un seul écran) :
   * il passe en mode « kiosk » — aucune interface, que la toile — dès qu'un
   * dashboard lui parle, et il y revient si le dashboard disparaît.
   */
  private bindControl(): void {
    this.control = new ControlLink();
    this.control.onMessage((message) => {
      const command = message.command;
      if (command === undefined) return;
      this.controllerAt = Date.now();
      this.handleCommand(command);
    });
    this.controlTimer = window.setInterval(() => this.publishState(), 200);
    this.publishState();
  }

  private handleCommand(command: DashboardCommand): void {
    switch (command.type) {
      case "hello":
        break;
      case "set-latency":
        this.setLatency(command.ms);
        break;
      case "set-settings":
        this.applySettings(command.patch);
        break;
      case "capture":
        if (command.on) this.startExternalCapture(true);
        else this.closeExternalCapture();
        break;
      case "force-live":
        this.backToDrop();
        break;
      case "force-show": {
        const analysis = this.pendingAnalysis;
        if (analysis !== null) {
          this.debug("show", "show analysé local demandé depuis le dashboard");
          void this.startShow(analysis);
        }
        break;
      }
      case "cancel-analysis":
        this.analysisController?.abort();
        this.backToDrop();
        break;
      case "debug-overlay":
        this.setDebugOverlay(command.on);
        break;
      case "analysis-ready":
        this.receiveAnalysis(command);
        break;
    }
    // Une commande change presque toujours quelque chose d'visible.
    this.publishState();
  }

  /** Analyse faite par le dashboard : le show prend le relais et se cale. */
  private receiveAnalysis(command: Extract<DashboardCommand, { type: "analysis-ready" }>): void {
    this.jobId = command.jobId;
    this.pendingTitle = command.title;
    this.pendingAnalysis = command.analysis;
    this.lastError = null;
    this.clearNotice();
    this.debug("analyse", "analyse reçue du dashboard", {
      titre: command.title,
      dureeSec: Number(command.analysis.duration.toFixed(1)),
      temps: command.analysis.beats.length,
      montees: command.analysis.builds.length,
    });
    void this.tryAutoSynced(command.title, command.artist, command.analysis.duration, command.analysis);
  }

  private setLatency(ms: number): void {
    this.syncedLatencyMs = Math.max(-500, Math.min(1000, Math.round(ms)));
    localStorage.setItem("night-light-latency", String(this.syncedLatencyMs));
    // Sans ça, le dashboard continue d'afficher l'ancienne valeur : il ne peut
    // pas vérifier que son réglage est bien arrivé.
    this.debugSync.latencyMs = this.syncedLatencyMs;
    const input = document.getElementById("latency-offset") as HTMLInputElement | null;
    if (input !== null) input.value = String(this.syncedLatencyMs);
  }

  private applySettings(patch: Partial<ShowState["settings"]>): void {
    if (patch.intensity !== undefined) this.settings.intensity = Math.max(0, Math.min(2, patch.intensity));
    if (patch.flashes !== undefined) this.flashSlider = Math.max(0, Math.min(2, patch.flashes));
    if (patch.reduced !== undefined) this.settings.reduced = patch.reduced;
    if (patch.noflash !== undefined) this.noflash = patch.noflash;
    this.settings.flashes = this.noflash ? 0 : this.flashSlider;
    this.refreshPlan();
  }

  private setDebugOverlay(on: boolean): void {
    if (this.debugOverlayActive === on) return;
    this.debugOverlayActive = on;
    const overlay = document.getElementById("debug-overlay");
    if (overlay !== null) overlay.toggleAttribute("hidden", !on);
  }

  private showMode(): ShowMode {
    if (this.syncedMode && this.debugSync.phase === "SHOW_SYNCED") return "show-synced";
    if (this.syncedMode && this.debugSync.phase === "PAUSED") return "paused";
    if (this.syncedMode && this.debugSync.phase === "LOST") return "lost";
    if (this.syncedMode) return "syncing";
    if (this.view !== null) return "show-local";
    return "live";
  }

  /** État complet publié vers le dashboard, ~5 fois par seconde. */
  private publishState(): void {
    const link = this.control;
    if (link === null) return;
    const controlled = Date.now() - this.controllerAt < 3000;
    const etaitKiosk = document.body.classList.contains("kiosk");
    document.body.classList.toggle("kiosk", controlled);
    // Le passage en kiosk change la taille CSS du canvas (100vw x 100vh) : sans
    // nouveau calibrage, le tampon de dessin ne correspond plus à l'affichage.
    if (etaitKiosk !== controlled) {
      this.resize();
      dbgLog("boot", `écran de show ${controlled ? "piloté par le dashboard (interface masquée)" : "rendu à son interface"}`);
    }
    const state: ShowState = {
      version: 1,
      at: Date.now(),
      page: "show",
      screen: document.querySelector(".screen.is-active")?.id?.replace("screen-", "") as ShowState["screen"] ?? "drop",
      mode: this.showMode(),
      controlled,
      capture: {
        open: this.liveCapture !== null,
        state: this.debugCapture.state,
        source: this.debugCapture.source,
        error: this.debugCapture.error,
        rate: this.debugCapture.rate,
        messages: this.debugCapture.messages,
        lastAt: this.debugCapture.lastAt,
      },
      audio: { ...this.liveAudioRaw },
      smooth: { ...this.liveAudio },
      render: {
        liveFps: this.liveFps,
        liveQuality: this.liveQuality,
        liveFrame: this.liveFrame,
        showFps: this.fps,
        quality: this.quality,
        frame: this.frame,
      },
      sync: { ...this.debugSync },
      analysis:
        this.pendingAnalysis === null
          ? null
          : {
              title: this.pendingTitle,
              artist: "",
              durationSec: this.pendingAnalysis.duration,
              tempo: this.pendingAnalysis.tempo,
              beats: this.pendingAnalysis.beats.length,
              builds: this.pendingAnalysis.builds.length,
              sections: this.pendingAnalysis.sections.length,
            },
      settings: {
        intensity: this.settings.intensity,
        flashes: this.flashSlider,
        reduced: this.settings.reduced,
        noflash: this.noflash,
      },
      limits: this.limits === null ? null : { ...this.limits },
      debugOverlay: this.debugOverlayActive,
      error: this.lastError,
      notice: this.notice,
      log: debugLog.lines(10),
    };
    link.publishState(state);
  }



  private async tryAutoSynced(
    title: string,
    artist: string,
    duration: number,
    analysis: Analysis,
  ): Promise<void> {
    // Une analyse qui arrive pendant un show doit d'abord l'arrêter. Sans ça, le
    // deuxième morceau restait bloqué par la garde ci-dessous (`syncedMode` du
    // show précédent) et l'écran continuait d'afficher l'ancien.
    this.stopSyncedMode();
    this.stopLoop();
    this.audio.pause();
    this.view = null;
    this.plan = null;

    this.debugSync.phase = "SYNCING";
    this.debugSync.expectedTitle = title;
    this.debugSync.attempts = 0;
    this.debug("sync", "attente d'une lecture externe correspondante", { titre: title, artiste: artist || "—", dureeSec: Number(duration.toFixed(1)) });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // `view !== null` : un show local a été forcé entre-temps, on ne le remplace pas.
      if (!this.pendingAnalysis || this.view !== null) return;
      this.debugSync.attempts = attempt + 1;
      try {
        const state = await fetchPlaybackPosition(title, artist, duration);
        this.debugLastPlayer = {
          source: state.source,
          status: state.status,
          title: state.title,
          artist: state.artist,
          positionMs: state.positionMs,
          capturedAtMs: state.capturedAtMs,
        };
        this.debugSync.source = state.source;
        this.debugSync.playerTitle = state.title;
        this.debugSync.playerMs = state.positionMs;
        this.debugSync.showMs = state.positionMs + this.syncedLatencyMs;
        const match = state.match?.accepted === true;
        const durationDelta = state.match?.durationDeltaSec ?? null;
        const formatOk = durationDelta === null || durationDelta <= 3;
        const reasons = state.match?.reasons ?? [];
        this.debugSync.match = [
          match ? "correspondance OK" : "pas de correspondance",
          reasons.length > 0 ? `motifs=${reasons.join(",")}` : "motifs=aucun",
          durationDelta === null ? "durée non comparée" : `écart durée ${durationDelta.toFixed(2)}s`,
          `statut=${state.status}`,
        ].join(" · ");
        dbgThrottled(
          "sync-attempt",
          "sync",
          `tentative ${attempt + 1}/10 de synchronisation`,
          {
            source: state.source,
            lecteur: state.title || "—",
            positionSec: Number((state.positionMs / 1000).toFixed(2)),
            statut: state.status,
            correspondance: match,
            motifs: reasons,
            ecartDureeSec: durationDelta,
          },
          1500,
        );
        if (match && formatOk && state.status === "playing") {
          // Position ramenée à l'instant présent : la mesure date du sous-processus
          // playerctl, pas de la réponse HTTP.
          const initialMs = estimatePlayerPositionMs(
            {
              source: state.source,
              status: state.status,
              title: state.title,
              artist: state.artist,
              positionMs: state.positionMs,
              capturedAtMs: state.capturedAtMs,
            },
            Date.now(),
          );
          await this.startSyncedShow(analysis, initialMs, state);
          return;
        }
      } catch (error) {
        this.debugSync.match = "position injoignable";
        this.debug("erreur", "lecture de position impossible", error instanceof Error ? error.message : String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // Aucune lecture correspondante pendant 20 s : on renonce proprement.
    this.fallbackToLive(title, "Aucune position MPRIS/Spotify correspondante pendant 20 s.");
  }

  private async startSyncedShow(analysis: Analysis, initialMs: number, state?: PlaybackPositionResponse): Promise<void> {
    // Un show déjà en cours (calé ou local) doit s'arrêter net : sinon son
    // minuteur et sa boucle de rendu survivent au nouveau show.
    this.stopSyncedMode();
    this.stopLoop();
    this.audio.pause();
    this.view = null;
    this.plan = null;

    this.stopLiveMode();
    // On coupe le visualiseur en barres, PAS la capture : l'audio vient du
    // lecteur externe (aucun risque de boucle), et le tableau de bord continue
    // ainsi d'afficher le son en direct pendant tout le show.
    this.stopLiveRender();
    this.liveMode = false;
    this.syncedMode = true;
    this.debugSync.phase = "SHOW_SYNCED";
    if (state !== undefined) {
      this.debugSync.source = state.source;
      this.debugSync.playerTitle = state.title;
    }
    this.debugSync.expectedTitle = this.pendingTitle;
    this.debugSync.latencyMs = this.syncedLatencyMs;
    this.debugSync.match = "show lancé à la position du lecteur";

    this.syncedView = new TrackView(analysis);
    this.syncedPlan = buildShowPlan(analysis, this.effectiveReduced());
    // Le show s'ouvre depuis le noir au lieu d'apparaître d'un coup.
    this.beginTransition();
    this.syncedStartMs = initialMs + this.syncedLatencyMs;
    this.syncedStartedAtEpoch = Date.now();
    if (this.syncedTimer !== null) window.clearInterval(this.syncedTimer);
    this.syncedTimer = window.setInterval(() => void this.resyncSynced(analysis.duration), 2500);
    this.startSyncedLoop();
    setStatus(`Show synchronisé lancé : ${this.pendingTitle}.`);
    this.debug("sync", "show synchronisé démarré", {
      titre: this.pendingTitle,
      source: state?.source ?? "?",
      positionLecteurSec: Number((initialMs / 1000).toFixed(2)),
      latenceMs: this.syncedLatencyMs,
      positionShowSec: Number((this.syncedStartMs / 1000).toFixed(2)),
      dureeSec: Number(analysis.duration.toFixed(1)),
    });
  }

  private startSyncedLoop(): void {
    if (this.syncedRaf !== 0) return;
    const loop = (): void => {
      this.syncedRaf = requestAnimationFrame(loop);
      if (!this.syncedMode || this.syncedView === null || this.syncedPlan === null) return;
      this.renderSynced();
    };
    this.syncedRaf = requestAnimationFrame(loop);
  }

  private stopSyncedMode(): void {
    if (this.syncedRaf !== 0) cancelAnimationFrame(this.syncedRaf);
    this.syncedRaf = 0;
    if (this.syncedTimer !== null) {
      window.clearInterval(this.syncedTimer);
      this.syncedTimer = null;
    }
    this.syncedMode = false;
  }

  private renderSynced(): void {
    const view = this.syncedView;
    const plan = this.syncedPlan;
    if (view === null || plan === null) return;
    // Horloge epoch, la même que celle du serveur : indispensable pour comparer
    // la position du show à celle du lecteur.
    const elapsed = Date.now() - this.syncedStartedAtEpoch;
    const time = Math.max(0, (this.syncedStartMs + elapsed) / 1000);
    try {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderFrame({
        ctx: this.ctx,
        width: this.canvas.clientWidth,
        height: this.canvas.clientHeight,
        dpr: this.canvas.width / Math.max(1, this.canvas.clientWidth),
        time: Math.min(time, view.duration),
        view,
        plan,
        settings: this.settings,
        reducedMotion: this.reducedMotion,
        quality: this.quality,
        frame: this.frame,
      });
      this.frame += 1;
      this.drawTransitionIfNeeded(Math.min(time, view.duration), plan);
    } catch (error) {
      this.debug("erreur", "rendu synchronisé interrompu", error instanceof Error ? error.message : String(error));
      console.error("Rendu synchronisé interrompu", error);
    }
  }

  private async resyncSynced(duration: number): Promise<void> {
    if (!this.syncedMode || this.syncedView === null) return;
    // Même horloge que le serveur (epoch) : la comparaison avec la position du
    // lecteur n'a de sens qu'à cette condition.
    const nowMs = Date.now();
    try {
      const state = await fetchPlaybackPosition(this.pendingTitle, "", duration);
      this.debugSync.resyncAt = nowMs;
      this.debugSync.source = state.source;
      this.debugSync.playerTitle = state.title;
      this.debugSync.expectedTitle = this.pendingTitle;
      this.debugSync.latencyMs = this.syncedLatencyMs;

      if (state.title && this.pendingTitle && normalizePlaybackText(state.title) !== normalizePlaybackText(this.pendingTitle)) {
        this.debug("sync", "changement de morceau détecté · retour en Live", {
          attendu: this.pendingTitle,
          lecteur: state.title,
        });
        this.backToDrop();
        return;
      }

      const player = {
        source: state.source,
        status: state.status,
        title: state.title,
        artist: state.artist,
        positionMs: state.positionMs,
        capturedAtMs: state.capturedAtMs,
      };
      this.debugLastPlayer = player;
      // Position réelle du lecteur, puis cible du show : le réglage de latence
      // place volontairement le show en avance sur le son (Bluetooth, HDMI…).
      const playerMs = estimatePlayerPositionMs(player, nowMs);
      const targetShowMs = playerMs + this.syncedLatencyMs;
      const drift = showDriftMs(player, nowMs, this.syncedStartMs, this.syncedStartedAtEpoch, this.syncedLatencyMs);
      // L'écart mesuré avant correction sert à décider, pas à s'afficher : ce qui
      // compte pour l'utilisateur est l'écart résiduel une fois recadré.
      const driftAvantCorrection = drift;

      if (state.status === "paused") {
        this.debugSync.phase = "PAUSED";
        this.debugSync.match = "lecture en pause · show figé";
        this.syncedStartedAtEpoch = Date.now();
        this.syncedStartMs = playerMs;
        this.debug("sync", "lecture en pause · show figé sur place", {
          positionSec: Number((this.syncedStartMs / 1000).toFixed(2)),
        });
        return;
      }

      if (state.status !== "playing") {
        this.debugSync.phase = "LOST";
        this.debugSync.match = `lecteur statut=${state.status}`;
        this.debug("sync", `statut de lecture inattendu (${state.status}) · show laissé en l'état`);
        return;
      }

      this.debugSync.phase = "SHOW_SYNCED";
      const correction = syncCorrection(drift);
      if (correction === "hard") {
        this.debugSync.match = "écart ≥ 1,5 s · recalage direct";
        this.syncedStartMs = targetShowMs;
        this.syncedStartedAtEpoch = nowMs;
        this.debug("sync", "écart important · recalage direct du show", {
          ecartMs: Math.round(driftAvantCorrection),
          nouvellePositionSec: Number((this.syncedStartMs / 1000).toFixed(2)),
          positionLecteurSec: Number((playerMs / 1000).toFixed(2)),
        });
      } else if (correction === "soft") {
        this.syncedStartMs = targetShowMs - (nowMs - this.syncedStartedAtEpoch);
        this.debugSync.match = "écart > 150 ms · origine recalculée";
        this.debug("sync", "dérive détectée · origine du show recalculée", {
          ecartMs: Math.round(driftAvantCorrection),
          positionShowSec: Number((this.syncedStartMs / 1000).toFixed(2)),
          positionLecteurSec: Number((playerMs / 1000).toFixed(2)),
        });
      } else {
        this.debugSync.match = "synchronisé (≤ 150 ms)";
        dbgThrottled(
          "resync",
          "sync",
          "synchronisé",
          {
            ecartMs: Math.round(drift),
            lecteurSec: Number((playerMs / 1000).toFixed(2)),
            showSec: Number(((this.syncedStartMs + (Date.now() - this.syncedStartedAtEpoch)) / 1000).toFixed(2)),
            latenceMs: this.syncedLatencyMs,
          },
          5000,
        );
      }

      // Affichage de l'état APRÈS correction : l'écart résiduel est la seule
      // valeur qui décrit ce que voit l'utilisateur.
      this.debugSync.playerMs = estimatePlayerPositionMs(player, Date.now());
      this.debugSync.showMs = this.syncedStartMs + (Date.now() - this.syncedStartedAtEpoch);
      this.debugSync.driftMs = showDriftMs(
        player,
        Date.now(),
        this.syncedStartMs,
        this.syncedStartedAtEpoch,
        this.syncedLatencyMs,
      );
    } catch (error) {
      this.debugSync.phase = "LOST";
      this.debugSync.match = "position de lecture injoignable";
      this.debug("erreur", "position de lecture injoignable pendant la resynchronisation", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureLiveView(): Promise<void> {
    if (this.liveView !== null && this.livePlan !== null) return;
    const analysis: Analysis = {
      schema: 1,
      duration: 1_000_000,
      tempo: 120,
      beatCount: 0,
      beatPeriod: 0.5,
      beats: [],
      onsets: [],
      energy: [[0, 0]],
      bass: [[0, 1 / 3]],
      mid: [[0, 1 / 3]],
      high: [[0, 1 / 3]],
      sections: [{ start: 0, end: 1_000_000, label: "intense", energy: 0.5 }],
      builds: [],
    };
    this.liveView = new TrackView(analysis);
    this.livePlan = {
      duration: 1_000_000,
      seed: 1,
      scenes: [
        {
          index: 0,
          start: 0,
          end: 1_000_000,
          family: "beams",
          variant: "tunnel",
          backdrop: "waves",
          palette: { name: "magenta-cyan", hue: 318, accent: 188, spread: 44, saturation: 0.88, lightness: 0.64 },
          intensity: 0.6,
          fadeIn: 0.7,
          fadeOut: 0.9,
          mood: "pulse",
          reason: "ouverture",
        },
      ],
      barStarts: [],
      track: { name: "magenta-cyan", hue: 318, accent: 188, spread: 44 },
      backdrop: "waves",
    };
  }

  private async startLiveMode(): Promise<void> {
    this.liveMode = true;
    this.liveTimeStart = performance.now();
    this.debugSync.phase = "LIVE";
    this.debugSync.match = "";
    this.debugSync.attempts = 0;
    await this.ensureLiveView();
    this.startExternalCapture(true);
    this.startLiveLoop();
    this.beginTransition();
    this.debug("live", "mode live démarré · capture du son du PC ouverte");
  }

  private startExternalCapture(force: boolean): void {
    // `force` conservé pour l'interface future ; la capture est ouverte via le même flux.
    if (force && this.liveCapture === null) this.openExternalCapture();
  }

  private startLiveLoop(): void {
    if (this.liveMainRaf !== 0) return;
    this.liveLastTs = 0;
    const loop = (timestamp: number): void => {
      this.liveMainRaf = requestAnimationFrame(loop);
      if (!this.liveMode) return;
      if (this.liveLastTs === 0) {
        this.liveLastTs = timestamp;
        return;
      }
      const delta = timestamp - this.liveLastTs;
      this.liveLastTs = timestamp;
      if (delta > 0) {
        const instant = 1000 / delta;
        this.liveFps += (instant - this.liveFps) * 0.06;
        const wanted = quantizeQuality(this.liveFps / 52);
        if (wanted === this.liveQuality) this.liveQualityHold = 0;
        else {
          this.liveQualityHold += 1;
          if (this.liveQualityHold >= 24) {
            this.liveQuality = wanted;
            this.liveQualityHold = 0;
          }
        }
      }
      this.tickLive();
    };
    this.liveMainRaf = requestAnimationFrame(loop);
  }

  private stopLiveMode(): void {
    if (this.liveMainRaf !== 0) cancelAnimationFrame(this.liveMainRaf);
    this.liveMainRaf = 0;
  }

  private tickLive(): void {
    if (!this.liveMode || this.liveView === null || this.livePlan === null) return;
    const target = this.liveAudioRaw;
    if (target.updatedAt > this.liveAudio.updatedAt) {
      this.liveAudio = smoothLiveFeatures(this.liveAudio, target, 0.4);
    }
    const time = (performance.now() - this.liveTimeStart) / 1000;
    this.renderLive(time);
  }

  private renderLive(time: number): void {
    const view = this.liveView;
    const plan = this.livePlan;
    if (view === null || plan === null) return;
    try {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderFrame({
        ctx: this.ctx,
        width: this.canvas.clientWidth,
        height: this.canvas.clientHeight,
        dpr: this.canvas.width / Math.max(1, this.canvas.clientWidth),
        time,
        view,
        plan,
        settings: this.settings,
        reducedMotion: this.reducedMotion,
        quality: this.liveQuality,
        frame: this.liveFrame,
        liveAudio: this.liveAudio,
      });
      this.liveFrame += 1;
      this.drawTransitionIfNeeded(time, plan);
      if (this.liveFrame % 120 === 0) {
        dbgThrottled(
          "live-render",
          "live",
          "rendu live en cours",
          {
            fps: this.liveFps.toFixed(1),
            qualite: this.liveQuality.toFixed(2),
            images: this.liveFrame,
            rms: num(this.liveAudio.rms),
            energie: num(this.liveAudio.energy),
          },
          4000,
        );
      }
    } catch (error) {
      this.liveQuality = quantizeQuality(this.liveQuality * 0.7);
      this.debug("erreur", "rendu live interrompu", error instanceof Error ? error.message : String(error));
      console.error("Rendu live interrompu", error);
    }
  }

  /* -------------------------------------------------------------- spectacle */

  private bindShow(): void {
    el<HTMLButtonElement>("btn-play").addEventListener("click", () => void this.togglePlay());
    el<HTMLButtonElement>("btn-restart").addEventListener("click", () => void this.restart());
    el<HTMLButtonElement>("btn-change-track").addEventListener("click", () => {
      this.backToDrop();
    });
    el<HTMLButtonElement>("btn-fullscreen").addEventListener("click", () => void this.toggleFullscreen());

    el<HTMLInputElement>("volume").addEventListener("input", () => {
      this.audio.setVolume(Number(el<HTMLInputElement>("volume").value) / 100);
    });
    this.audio.setVolume(0.8);

    this.settings.intensity = Number(el<HTMLInputElement>("intensity").value) / 100;
    this.flashSlider = Number(el<HTMLInputElement>("flashes").value) / 100;
    this.noflash = el<HTMLInputElement>("chk-noflash").checked;
    this.settings.flashes = this.noflash ? 0 : this.flashSlider;

    el<HTMLInputElement>("intensity").addEventListener("input", () => {
      this.settings.intensity = Number(el<HTMLInputElement>("intensity").value) / 100;
    });
    el<HTMLInputElement>("flashes").addEventListener("input", () => {
      this.flashSlider = Number(el<HTMLInputElement>("flashes").value) / 100;
      this.settings.flashes = this.noflash ? 0 : this.flashSlider;
    });
    el<HTMLInputElement>("chk-reduced").addEventListener("change", () => {
      this.settings.reduced = el<HTMLInputElement>("chk-reduced").checked;
      this.refreshPlan();
    });
    el<HTMLInputElement>("chk-noflash").addEventListener("change", () => {
      this.noflash = el<HTMLInputElement>("chk-noflash").checked;
      this.settings.flashes = this.noflash ? 0 : this.flashSlider;
    });

    const seek = el<HTMLInputElement>("seek");
    seek.addEventListener("input", () => {
      this.seeking = true;
      const duration = this.view?.duration ?? 0;
      el<HTMLElement>("time-current").textContent = formatTime((Number(seek.value) / 1000) * duration);
    });
    seek.addEventListener("change", () => {
      const duration = this.view?.duration ?? 0;
      this.audio.seek((Number(seek.value) / 1000) * duration);
      this.seeking = false;
    });

    el<HTMLButtonElement>("hud-toggle").addEventListener("click", () => {
      const hud = el<HTMLElement>("hud");
      const collapsed = hud.classList.toggle("is-collapsed");
      el<HTMLButtonElement>("hud-toggle").setAttribute("aria-expanded", String(!collapsed));
    });

    this.audio.on("error", () => {
      const code = this.audio.element.error?.code ?? 0;
      setShowError(
        "Lecture impossible",
        "Le navigateur n'a pas réussi à lire ce morceau. Essaie un autre format (WAV ou MP3 sont les plus sûrs).",
        `MediaError code ${code}`,
      );
      showScreen("error");
      this.stopLoop();
    });

    this.audio.on("loadedmetadata", () => {
      if (this.view !== null) this.syncTrackLabels();
    });

    this.audio.onEnded(() => {
      setPlaying(false);
      this.stopLoop();
      this.renderAt(this.view?.duration ?? this.audio.duration);
      setStatus("Spectacle terminé. Tu peux le relancer ou changer de morceau.");
    });
  }

  private async startShow(analysis: Analysis): Promise<void> {
    // Les deux modes de show sont exclusifs : sans ça, le minuteur de
    // resynchronisation continue de tourner et finit par voir un « changement
    // de morceau » face au lecteur, ce qui coupait le show local net.
    this.stopSyncedMode();

    this.stopLiveMode();
    this.closeExternalCapture();
    this.liveMode = false;
    const title = this.pendingTitle;
    this.debugSync.phase = "SHOW_LOCAL";
    this.debugSync.expectedTitle = title;
    this.debugSync.match = "show analysé local (touche S)";
    this.session = {
      jobId: this.jobId,
      title,
      duration: analysis.duration,
      startedAt: Date.now(),
    };
    this.view = new TrackView(analysis);
    this.plan = buildShowPlan(analysis, this.effectiveReduced());
    this.beginTransition();
    this.audio.load(audioUrl(this.jobId));
    const detectedPosition = this.nowPlaying?.positionSec;
    if (this.nowPlaying?.status === "playing" && Number.isFinite(detectedPosition)) {
      const offset = detectedPosition as number;
      this.audio.element.addEventListener(
        "loadedmetadata",
        () => {
          try {
            (this.audio.element as HTMLAudioElement).currentTime = Math.max(0, Math.min(this.audio.duration || offset, offset));
          } catch {
            /* ignore */
          }
        },
        { once: true },
      );
    }
    this.audio.setVolume(Number(el<HTMLInputElement>("volume").value) / 100);

    el<HTMLElement>("np-title").textContent = title;
    el<HTMLElement>("np-info").textContent = `${formatTime(analysis.duration)} · ${analysis.tempo.toFixed(1)} BPM`;
    el<HTMLElement>("hud-track").textContent = title;
    el<HTMLElement>("time-total").textContent = formatTime(analysis.duration);

    showScreen("show");
    this.resize();
    this.quality = 1;
    this.fps = 60;
    this.frame = 0;

    try {
      await this.audio.play();
      setPlaying(true);
      this.startLoop();
      setStatus(`Spectacle lancé : ${title}.`);
    } catch (error) {
      setShowError(
        "Lecture bloquée",
        "Le navigateur a refusé la lecture automatique. Appuie une nouvelle fois sur lecture.",
        error instanceof Error ? error.message : String(error),
      );
      showScreen("error");
    }
  }

  private effectiveReduced(): boolean {
    return this.settings.reduced || this.reducedMotion;
  }

  private refreshPlan(): void {
    const analysis = this.view?.analysis;
    if (analysis === undefined) return;
    this.plan = buildShowPlan(analysis, this.effectiveReduced());
  }

  private async togglePlay(): Promise<void> {
    if (this.view === null) return;
    if (this.audio.paused) {
      if (this.audio.currentTime >= this.view.duration - 0.05) this.audio.seek(0);
      await this.audio.play();
      setPlaying(true);
      this.startLoop();
    } else {
      this.audio.pause();
      setPlaying(false);
      this.stopLoop();
    }
  }

  private async restart(): Promise<void> {
    if (this.view === null) return;
    this.audio.seek(0);
    await this.audio.play();
    setPlaying(true);
    this.startLoop();
    setStatus("Spectacle rejoué depuis le début.");
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement === null) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      setStatus("Plein écran refusé par le navigateur.");
    }
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      switch (event.key) {
        case "s":
        case "S": {
          // Échappatoire discret : show analysé en local si la synchro est impossible.
          const analysis = this.pendingAnalysis;
          this.debug("show", "show analysé local forcé au clavier (S)", { titre: this.pendingTitle });
          if (analysis !== null) void this.startShow(analysis);
          break;
        }
        case " ":
          event.preventDefault();
          void this.togglePlay();
          break;
        case "r":
        case "R":
          void this.restart();
          break;
        case "f":
        case "F":
          void this.toggleFullscreen();
          break;
        case "ArrowLeft":
          this.audio.seek(this.audio.currentTime - 5);
          break;
        case "ArrowRight":
          this.audio.seek(this.audio.currentTime + 5);
          break;
        case "ArrowUp":
          event.preventDefault();
          this.bumpVolume(0.05);
          break;
        case "ArrowDown":
          event.preventDefault();
          this.bumpVolume(-0.05);
          break;
        default:
          break;
      }
    });
  }

  private bumpVolume(delta: number): void {
    const slider = el<HTMLInputElement>("volume");
    const next = clamp(Number(slider.value) + delta * 100, 0, 100);
    slider.value = String(Math.round(next));
    this.audio.setVolume(next / 100);
  }

  /* --------------------------------------------------------------- boucle */

  private onReducedMotionChange = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
    if (this.reducedMotion) {
      el<HTMLInputElement>("chk-reduced").checked = true;
      this.settings.reduced = true;
    }
    this.refreshPlan();
  };

  private resize = (): void => {
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

  private startLoop(): void {
    if (this.rafId !== 0) return;
    this.lastTs = 0;
    const loop = (timestamp: number) => {
      this.rafId = requestAnimationFrame(loop);
      if (this.lastTs === 0) {
        this.lastTs = timestamp;
        return;
      }
      const delta = timestamp - this.lastTs;
      this.lastTs = timestamp;
      if (delta > 0) {
        const instant = 1000 / delta;
        this.fps += (instant - this.fps) * 0.06;
        this.updateQuality();
        // La résolution du canvas dépend de la qualité : sans ce rappel, un
        // passage sous la barre des 0,5 ne changerait jamais le dpr et le
        // spectacle continuerait à rendre en haute résolution alors qu'il rame.
        const band = this.quality < 0.5;
        if (band !== this.qualityBand) {
          this.qualityBand = band;
          this.resize();
        }
      }
      this.tick();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /**
   * Qualité réduite à des paliers, avec hystérésis.
   *
   * Le fps varie en continu ; en le passant tel quel au rendu, chaque
   * variation changeait le nombre d'éléments dessinés de 1 à 3 unités. Les
   * familles calculant leurs positions par `i / n`, tout se décalait d'un coup :
   * le spectacle « sautait » d'une image à l'autre, sur tous les types de scène.
   * Un palier n'est adopté que s'il est demandé sans interruption pendant
   * `QUALITY_HOLD_FRAMES`, ce qui supprime les bascules intempestives.
   */
  private updateQuality(): void {
    const wanted = quantizeQuality(this.fps / 52);
    if (wanted === this.quality) {
      this.qualityHold = 0;
      return;
    }
    this.qualityHold += 1;
    if (this.qualityHold < QUALITY_HOLD_FRAMES) return;
    this.quality = wanted;
    this.qualityHold = 0;
  }

  private stopLoop(): void {
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private tick(): void {
    const view = this.view;
    const plan = this.plan;
    if (view === null || plan === null) return;
    this.renderAt(this.audio.currentTime);
    this.updateHud();
  }

  /* --------------------------------------------------------------- transition */

  /**
   * Déclenche une ouverture depuis le noir. Utilisée à chaque changement de
   * nature du spectacle : entrée dans le show programmé, retour au direct,
   * lancement du show local.
   */
  private beginTransition(durationMs = 1500): void {
    this.transitionStart = performance.now();
    this.transitionDuration = Math.max(200, durationMs);
  }

  /**
   * Ouvre l'image : voile noir qui se lève, avec un front lumineux qui balaie.
   * Appelée après chaque rendu, pendant la transition uniquement.
   */
  private drawTransitionIfNeeded(time: number, plan: ShowPlan): void {
    if (this.transitionStart === 0) return;
    const progress = (performance.now() - this.transitionStart) / this.transitionDuration;
    if (progress >= 1) {
      this.transitionStart = 0;
      return;
    }
    const scene = sceneAt(plan, Math.max(0, time));
    drawTransition(this.ctx, this.canvas.clientWidth, this.canvas.clientHeight, progress, scene.palette.hue);
  }

  private renderAt(time: number): void {
    const view = this.view;
    const plan = this.plan;
    if (view === null || plan === null) return;
    const clamped = clamp(time, 0, view.duration);
    try {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderFrame({
        ctx: this.ctx,
        width: this.canvas.clientWidth,
        height: this.canvas.clientHeight,
        dpr: this.canvas.width / Math.max(1, this.canvas.clientWidth),
        time: clamped,
        view,
        plan,
        settings: this.settings,
        reducedMotion: this.reducedMotion,
        quality: this.quality,
        frame: this.frame,
      });
      this.frame += 1;
      this.drawTransitionIfNeeded(clamped, plan);
    } catch (error) {
      // Le rendu a échoué : on descend d'un palier. La valeur reste quantifiée,
      // sinon le nombre d'éléments recommencerait à varier à chaque image.
      this.quality = quantizeQuality(this.quality * 0.7);
      console.error("Rendu interrompu", error);
    }
  }

  private updateHud(): void {
    const now = performance.now();
    if (now - this.lastHudUpdate < 90) return;
    this.lastHudUpdate = now;
    const view = this.view;
    if (view === null) return;
    const t = this.audio.currentTime;
    if (!this.seeking) {
      const ratio = view.duration > 0 ? clamp(t / view.duration, 0, 1) : 0;
      el<HTMLInputElement>("seek").value = String(Math.round(ratio * 1000));
    }
    el<HTMLElement>("time-current").textContent = formatTime(t);
    const section = view.sectionAt(t);
    const scene = sceneAt(this.plan ?? buildShowPlan(view.analysis, this.effectiveReduced()), t);
    const label = SECTION_LABELS[section.label] ?? section.label;
    // La teinte affichée est celle réellement dessinée (même fonction, mêmes
    // entrées) : avant, le HUD recalculait sa propre dérive et annonçait une
    // couleur qui n'était pas à l'écran.
    const drop = view.buildIntensity(t);
    const variation = this.effectiveReduced() ? 0 : variationStrength(scene, t);
    const hue = sceneHue(scene, t, drop, variation, this.effectiveReduced());
    const moment = drop > 0.5 ? "impact" : variation > 0.4 ? "variation" : MOOD_LABELS[scene.mood];
    el<HTMLElement>("section-label").textContent =
      `${label} · ${SCENE_REASON_LABELS[scene.reason]} · ${moment} · ` +
      `${FAMILY_LABELS[scene.family]} · ${Math.round(hue)}°`;
    el<HTMLElement>("hud-stats").textContent =
      `${view.tempo.toFixed(1)} BPM · énergie ${(view.energyAt(t) * 100).toFixed(0)} % · ` +
      `basses ${(view.bassAt(t) * 100).toFixed(0)} % · aigus ${(view.highAt(t) * 100).toFixed(0)} % · ` +
      `${this.fps.toFixed(0)} fps`;
  }

  private syncTrackLabels(): void {
    const view = this.view;
    if (view === null) return;
    const duration = this.audio.duration || view.duration;
    el<HTMLElement>("time-total").textContent = formatTime(duration);
  }

  private async releaseSession(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.view = null;
    this.plan = null;
    this.pendingAnalysis = null;
    if (session === null) return;
    try {
      await fetch(`/api/session/${encodeURIComponent(session.jobId)}`, { method: "DELETE" });
    } catch {
      // La suppression est un confort : le serveur purge de toute façon.
    }
  }
}
