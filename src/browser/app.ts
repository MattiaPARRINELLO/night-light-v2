import { AudioEngine } from "./audio";
import { ApiError, audioUrl, fetchHealth, uploadAndAnalyze, type Limits } from "../core/api";
import {
  FAMILY_LABELS,
  MOOD_LABELS,
  SCENE_REASON_LABELS,
  buildShowPlan,
  sceneAt,
  type ShowPlan,
} from "../core/show";
import { HUE_DRIFT_PER_SEC, variationStrength } from "../core/render";
import { renderFrame } from "../core/render";
import { clamp, formatTime } from "../core/series";
import { TrackView } from "../core/view";
import type { Analysis, RenderSettings } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { el, setDropError, setPlaying, setShowError, setStatus, setUploadState, showScreen } from "./ui";

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|weba|webm)$/i;
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

  private rafId = 0;
  private frame = 0;
  private lastTs = 0;
  private fps = 60;
  private quality = 1;
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
    this.bindAnalysis();
    this.bindShow();
    this.bindKeyboard();
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
    } catch {
      this.limits = null;
    }
  }

  dispose(): void {
    this.mediaQuery?.removeEventListener("change", this.onReducedMotionChange);
    window.removeEventListener("resize", this.resize);
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
    showScreen("analysis");
    setUploadState({
      phase: "Envoi",
      progress: 0,
      detail: `${(file.size / 1048576).toFixed(1)} Mo — le fichier part vers le serveur local`,
      title,
      meta: "Analyse audio en approche",
    });

    const controller = new AbortController();
    this.analysisController = controller;
    try {
      const { jobId, analysis } = await uploadAndAnalyze(file, {
        signal: controller.signal,
        onUploadProgress: (ratio) => {
          setUploadState({
            phase: "Envoi",
            progress: ratio * 0.25,
            detail: `${Math.round(ratio * 100)} % envoyé`,
          });
        },
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
      this.showReady(title, analysis, file.size);
    } catch (error) {
      if (error instanceof ApiError && error.code === "aborted") {
        this.backToDrop();
        return;
      }
      const message = error instanceof Error ? error.message : "Erreur inconnue pendant l'analyse.";
      const detail =
        error instanceof ApiError ? `${error.code}${error.detail ? ` — ${error.detail}` : ""}` : String(error);
      setShowError("L'analyse a échoué", message, detail);
      showScreen("error");
    } finally {
      this.analysisController = null;
    }
  }

  private showReady(title: string, analysis: Analysis, sizeBytes: number): void {
    setUploadState({
      phase: "Analyse terminée",
      progress: 1,
      detail:
        `Tempo ${analysis.tempo.toFixed(1)} BPM · ${analysis.beats.length} temps forts · ` +
        `${analysis.sections.length} sections`,
      title,
      meta: `Durée ${formatTime(analysis.duration)} · ${(sizeBytes / 1048576).toFixed(1)} Mo`,
    });
    el<HTMLButtonElement>("btn-cancel-analysis").hidden = true;
    el<HTMLButtonElement>("btn-launch").hidden = false;
    el<HTMLButtonElement>("btn-launch").focus();
    setStatus(`Analyse de ${title} terminée. Spectacle prêt.`);
  }

  private bindAnalysis(): void {
    el<HTMLButtonElement>("btn-launch").addEventListener("click", () => {
      const analysis = this.pendingAnalysis;
      if (analysis === null) return;
      void this.startShow(analysis);
    });
    el<HTMLButtonElement>("btn-cancel-analysis").addEventListener("click", () => {
      this.analysisController?.abort();
      this.backToDrop();
    });
    el<HTMLButtonElement>("btn-error-back").addEventListener("click", () => {
      this.backToDrop();
    });
  }

  private backToDrop(): void {
    this.stopLoop();
    this.audio.pause();
    void this.releaseSession();
    el<HTMLButtonElement>("btn-cancel-analysis").hidden = false;
    el<HTMLButtonElement>("btn-launch").hidden = true;
    setUploadState({ phase: "Préparation", progress: 0, detail: "Envoi du fichier…" });
    showScreen("drop");
    setStatus("Écran de dépôt. Dépose un morceau pour lancer un spectacle.");
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

    el<HTMLInputElement>("intensity").addEventListener("input", () => {
      this.settings.intensity = Number(el<HTMLInputElement>("intensity").value) / 100;
    });
    el<HTMLInputElement>("flashes").addEventListener("input", () => {
      this.settings.flashes = Number(el<HTMLInputElement>("flashes").value) / 100;
    });
    el<HTMLInputElement>("chk-reduced").addEventListener("change", () => {
      this.settings.reduced = el<HTMLInputElement>("chk-reduced").checked;
      this.refreshPlan();
    });
    el<HTMLInputElement>("chk-noflash").addEventListener("change", () => {
      this.settings.flashes = el<HTMLInputElement>("chk-noflash").checked ? 0 : this.readFlashSlider();
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

  private readFlashSlider(): number {
    return Number(el<HTMLInputElement>("flashes").value) / 100;
  }

  private async startShow(analysis: Analysis): Promise<void> {
    const title = this.pendingTitle;
    this.session = {
      jobId: this.jobId,
      title,
      duration: analysis.duration,
      startedAt: Date.now(),
    };
    this.view = new TrackView(analysis);
    this.plan = buildShowPlan(analysis, this.effectiveReduced());
    this.audio.load(audioUrl(this.jobId));
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
        this.quality = clamp(this.fps / 52, 0.35, 1);
      }
      this.tick();
    };
    this.rafId = requestAnimationFrame(loop);
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
    } catch (error) {
      this.quality = Math.max(0.3, this.quality * 0.7);
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
    // La teinte affichée est celle réellement dessinée (glissement + drop).
    const drift = HUE_DRIFT_PER_SEC * (t - scene.start) * (this.effectiveReduced() ? 0.4 : 1);
    const drop = view.buildIntensity(t);
    const hue = (scene.palette.hue + drift + 70 * drop) % 360;
    const variation = this.effectiveReduced() ? 0 : variationStrength(scene, t);
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
