/**
 * Tableau de bord de Night Light.
 *
 * L'écran de projection n'a aucune interface : tout se règle ici. La page
 * parle à l'écran de show par `BroadcastChannel` (protocole dans
 * `src/shared/control.ts`) et appelle directement l'API pour ce qu'elle sait
 * faire elle-même : récupérer un morceau, lancer une analyse.
 */

import {
  ApiError,
  fetchHealth,
  resolveAndAnalyze,
  uploadAndAnalyze,
  type Limits,
} from "../core/api";
import {
  ControlLink,
  MODE_LABELS,
  SCREEN_LABELS,
  emptyShowState,
  type DashboardCommand,
  type ShowState,
} from "../shared/control";

/** Durée d'historique affichée sur les courbes, en millisecondes. */
const HISTORY_MS = 60_000;
/** Pas d'échantillonnage des courbes. */
const SAMPLE_MS = 250;
/** Au-delà, on considère l'écran de show injoignable. */
const LINK_TIMEOUT_MS = 3000;

interface Sample {
  at: number;
  rms: number;
  showMs: number;
  playerMs: number;
  driftMs: number;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Élément manquant dans le DOM : #${id}`);
  return node as T;
}

function seconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${Math.round(value)} ms`;
}

/** Dessine une courbe dans un canvas, avec une échelle fixe et lisible. */
function drawSeries(
  canvas: HTMLCanvasElement,
  samples: Sample[],
  pick: (sample: Sample) => number,
  color: string,
  options: { min?: number; max?: number; zero?: boolean } = {},
): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const min = options.min ?? 0;
  const max = options.max ?? 1;
  const span = Math.max(max - min, 1e-6);

  if (options.zero === true) {
    const y = h - ((0 - min) / span) * h;
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (samples.length < 2) return;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const timeSpan = Math.max(last.at - first.at, 1);
  ctx.beginPath();
  for (const sample of samples) {
    const x = ((sample.at - first.at) / timeSpan) * w;
    const value = Math.min(Math.max(pick(sample), min), max);
    const y = h - ((value - min) / span) * h;
    if (sample === first) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** Spectre en barres : basses, médiums, aigus sur trois blocs de largeur. */
function drawSpectrum(canvas: HTMLCanvasElement, state: ShowState): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const bands: Array<[string, number]> = [
    ["basses", state.audio.bass],
    ["médiums", state.audio.mid],
    ["aigus", state.audio.high],
  ];
  const barWidth = w / bands.length;
  for (const [index, [label, value]] of bands.entries()) {
    const x = index * barWidth;
    const height = h * Math.min(1, Math.max(0.04, value));
    const gradient = ctx.createLinearGradient(0, h - height, 0, h);
    gradient.addColorStop(0, `hsla(${190 + index * 55}, 85%, 66%, 0.95)`);
    gradient.addColorStop(1, `hsla(${190 + index * 55}, 85%, 45%, 0.55)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(x + barWidth * 0.14, h - height, barWidth * 0.72, height);
    ctx.fillStyle = "rgba(220,232,248,0.55)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(label, x + barWidth * 0.14, h - 4);
  }

  // Energie globale : trait horizontal, pour situer les trois bandes.
  ctx.fillStyle = `rgba(255,255,255,${0.12 + state.audio.energy * 0.35})`;
  ctx.fillRect(0, h - 2 - state.audio.energy * (h - 20), w, 1.5);
}

class Dashboard {
  private readonly link = new ControlLink();
  private state: ShowState = emptyShowState();
  private readonly limits = new Map<string, Limits>();
  private samples: Sample[] = [];
  private lastSampleAt = 0;
  private controller: AbortController | null = null;

  constructor() {
    this.link.onMessage((message) => {
      if (message.state === undefined) return;
      this.state = message.state;
      this.render();
      this.sample();
    });
    // On se présente tout de suite : l'écran de show sait qu'il est piloté.
    this.send({ type: "hello" });
    window.setInterval(() => this.send({ type: "hello" }), 2000);
    window.setInterval(() => this.checkLink(), 1000);
    void this.loadLimits();
    this.bindControls();
    this.checkLink();
  }

  private send(command: DashboardCommand): void {
    this.link.send(command);
  }

  private async loadLimits(): Promise<void> {
    try {
      const health = await fetchHealth();
      this.limits.set("health", health.limits);
      el<HTMLElement>("limits-note").textContent =
        `Limites : ${Math.round(health.limits.maxFileBytes / 1048576)} Mo par fichier, ` +
        `${health.limits.maxDurationSec} s par morceau.`;
    } catch {
      el<HTMLElement>("limits-note").textContent = "Limites inconnues (serveur injoignable).";
    }
  }

  private checkLink(): void {
    const alive = this.state.at > 0 && Date.now() - this.state.at < LINK_TIMEOUT_MS;
    const pill = el<HTMLElement>("link-pill");
    pill.textContent = alive ? "Show connecté" : "Show hors ligne";
    pill.classList.toggle("pill-on", alive);
    pill.classList.toggle("pill-off", !alive);
    el<HTMLButtonElement>("btn-force-show").disabled = this.state.analysis === null;
  }

  private sample(): void {
    const now = Date.now();
    if (now - this.lastSampleAt < SAMPLE_MS) return;
    this.lastSampleAt = now;
    this.samples.push({
      at: now,
      rms: this.state.audio.rms,
      showMs: this.state.sync.showMs,
      playerMs: this.state.sync.playerMs,
      driftMs: this.state.sync.driftMs,
    });
    this.samples = this.samples.filter((sample) => now - sample.at <= HISTORY_MS);
  }

  /** Met à jour l'interface. Appelé à chaque état reçu (~5/s). */
  private render(): void {
    const state = this.state;
    const sync = state.sync;

    el<HTMLElement>("kpi-mode").textContent = MODE_LABELS[state.mode];
    el<HTMLElement>("kpi-screen").textContent = `écran : ${SCREEN_LABELS[state.screen]}`;
    el<HTMLElement>("kpi-capture").textContent = state.capture.open
      ? state.capture.state
      : "fermée";
    el<HTMLElement>("kpi-capture-note").textContent = state.capture.source === ""
      ? `${state.capture.messages} messages`
      : state.capture.source;

    el<HTMLElement>("kpi-position").textContent = seconds(sync.showMs);
    el<HTMLElement>("kpi-position-note").textContent =
      state.analysis === null ? "aucun morceau" : `${state.analysis.title}`;

    const drift = el<HTMLElement>("kpi-drift");
    drift.textContent = state.mode === "live" ? "—" : signed(sync.driftMs);
    drift.classList.toggle("is-good", Math.abs(sync.driftMs) <= 150);
    drift.classList.toggle("is-warn", Math.abs(sync.driftMs) > 150 && Math.abs(sync.driftMs) < 1500);
    drift.classList.toggle("is-bad", Math.abs(sync.driftMs) >= 1500);
    el<HTMLElement>("kpi-drift-note").textContent =
      state.mode === "live" ? "rien à caler en Live" : `tolérance 150 ms · latence ${sync.latencyMs} ms`;

    el<HTMLElement>("audio-rate").textContent = state.capture.open
      ? `${state.capture.rate.toFixed(1)} msg/s`
      : "capture fermée";
    if (!state.capture.open) {
      // Sans ça, un panneau figé sur les dernières valeurs ressemble à une panne.
      el<HTMLElement>("audio-rate").classList.add("is-off");
    } else {
      el<HTMLElement>("audio-rate").classList.remove("is-off");
    }
    el<HTMLElement>("val-rms").textContent = state.audio.rms.toFixed(3);
    el<HTMLElement>("val-energy").textContent = state.audio.energy.toFixed(3);
    el<HTMLElement>("val-bass").textContent = state.audio.bass.toFixed(2);
    el<HTMLElement>("val-mid").textContent = state.audio.mid.toFixed(2);
    el<HTMLElement>("val-high").textContent = state.audio.high.toFixed(2);
    el<HTMLElement>("val-transient").textContent = state.audio.transient.toFixed(3);

    el<HTMLElement>("sync-source").textContent = sync.source === "" ? "aucune source" : sync.source;
    el<HTMLElement>("sync-player").textContent = seconds(sync.playerMs);
    el<HTMLElement>("sync-show").textContent = seconds(sync.showMs);
    el<HTMLElement>("sync-drift").textContent = signed(sync.driftMs);
    el<HTMLElement>("sync-expected").textContent = sync.expectedTitle || "—";
    el<HTMLElement>("sync-read").textContent = sync.playerTitle || "—";
    el<HTMLElement>("sync-match").textContent = sync.match || "—";

    const reduced = el<HTMLInputElement>("chk-reduced");
    const noflash = el<HTMLInputElement>("chk-noflash");
    // Le champ reflète l'état réel du show, sauf pendant que l'utilisateur tape.
    const latency = el<HTMLInputElement>("latency");
    if (document.activeElement !== latency) latency.value = String(sync.latencyMs);
    const intensityInput = el<HTMLInputElement>("intensity");
    if (document.activeElement !== intensityInput) intensityInput.value = String(Math.round(state.settings.intensity * 100));
    const flashesInput = el<HTMLInputElement>("flashes");
    if (document.activeElement !== flashesInput) flashesInput.value = String(Math.round(state.settings.flashes * 100));
    el<HTMLElement>("intensity-value").textContent = `${Math.round(state.settings.intensity * 100)} %`;
    el<HTMLElement>("flashes-value").textContent = `${Math.round(state.settings.flashes * 100)} %`;
    if (document.activeElement !== reduced) reduced.checked = state.settings.reduced;
    if (document.activeElement !== noflash) noflash.checked = state.settings.noflash;

    drawSpectrum(el<HTMLCanvasElement>("audio-canvas"), state);
    drawSeries(el<HTMLCanvasElement>("rms-canvas"), this.samples, (sample) => sample.rms, "#7fd7ff", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("drift-canvas"), this.samples, (sample) => sample.driftMs, "#ffb86b", {
      min: -1500,
      max: 1500,
      zero: true,
    });

    const mode = el<HTMLElement>("mode-pill");
    mode.textContent = MODE_LABELS[state.mode];
    mode.classList.toggle("pill-mode", state.mode !== "live");

    const log = el<HTMLElement>("log");
    log.textContent = state.log.length === 0 ? "Rien à signaler." : state.log.join("\n");
    el<HTMLElement>("log-count").textContent = `${state.log.length} lignes`;

    // Un repli s'annonce en bas, sans prendre l'écran : c'est une information,
    // pas une erreur.
    const notice = el<HTMLElement>("notice");
    if (state.notice === null) {
      notice.hidden = true;
      notice.textContent = "";
    } else {
      notice.hidden = false;
      notice.textContent = state.notice.text;
    }

    // Les contrôles reflètent l'état réel du show, même réglé au clavier.
    el<HTMLButtonElement>("btn-capture").textContent = state.capture.open
      ? "Couper la capture"
      : "Écouter le son du PC";
  }

  /* ------------------------------------------------------------- contrôles */

  private bindControls(): void {
    const intensity = el<HTMLInputElement>("intensity");
    const flashes = el<HTMLInputElement>("flashes");
    const reduced = el<HTMLInputElement>("chk-reduced");
    const noflash = el<HTMLInputElement>("chk-noflash");
    const latency = el<HTMLInputElement>("latency");

    intensity.addEventListener("input", () => {
      el<HTMLElement>("intensity-value").textContent = `${intensity.value} %`;
      this.send({ type: "set-settings", patch: { intensity: Number(intensity.value) / 100 } });
    });
    flashes.addEventListener("input", () => {
      el<HTMLElement>("flashes-value").textContent = `${flashes.value} %`;
      this.send({ type: "set-settings", patch: { flashes: Number(flashes.value) / 100 } });
    });
    reduced.addEventListener("change", () => {
      this.send({ type: "set-settings", patch: { reduced: reduced.checked } });
    });
    noflash.addEventListener("change", () => {
      this.send({ type: "set-settings", patch: { noflash: noflash.checked } });
    });

    latency.addEventListener("change", () => {
      const value = Number(latency.value);
      if (Number.isFinite(value)) {
        this.send({ type: "set-latency", ms: Math.max(-500, Math.min(1000, value)) });
      }
    });
    el<HTMLButtonElement>("latency-wired").addEventListener("click", () => {
      latency.value = "0";
      this.send({ type: "set-latency", ms: 0 });
    });
    el<HTMLButtonElement>("latency-bt").addEventListener("click", () => {
      latency.value = "200";
      this.send({ type: "set-latency", ms: 200 });
    });
    el<HTMLButtonElement>("latency-calibrate").addEventListener("click", () => {
      this.send({ type: "set-latency", ms: Number(latency.value) || 0 });
    });

    el<HTMLButtonElement>("btn-capture").addEventListener("click", () => {
      this.send({ type: "capture", on: !this.state.capture.open });
    });
    el<HTMLButtonElement>("btn-force-live").addEventListener("click", () => {
      this.send({ type: "force-live" });
    });
    el<HTMLButtonElement>("btn-force-show").addEventListener("click", () => {
      this.send({ type: "force-show" });
    });
    el<HTMLButtonElement>("btn-debug").addEventListener("click", () => {
      this.send({ type: "debug-overlay", on: !this.state.debugOverlay });
    });
    el<HTMLButtonElement>("btn-cancel").addEventListener("click", () => {
      this.send({ type: "cancel-analysis" });
    });

    this.bindSource();
  }

  /** Dépôt de fichier et recherche par titre : le dashboard analyse, puis
   *  transmet l'analyse à l'écran de show qui se charge du calage. */
  private bindSource(): void {
    const zone = el<HTMLElement>("dropzone");
    const input = el<HTMLInputElement>("file-input");
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("is-dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-dragover"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("is-dragover");
      const file = event.dataTransfer?.files?.[0];
      if (file !== undefined) void this.analyzeFile(file);
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file !== undefined) void this.analyzeFile(file);
    });

    el<HTMLFormElement>("resolve-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const title = el<HTMLInputElement>("resolve-title").value.trim();
      const artist = el<HTMLInputElement>("resolve-artist").value.trim();
      if (title === "" || artist === "") return;
      void this.resolve(title, artist);
    });
  }

  private setProgress(phase: string, ratio: number, detail?: string): void {
    const box = el<HTMLElement>("analyze-progress");
    box.hidden = false;
    const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
    el<HTMLElement>("analyze-fill").style.width = `${percent}%`;
    el<HTMLElement>("analyze-phase").textContent = detail === undefined ? phase : `${phase} — ${detail}`;
    el<HTMLElement>("analyze-percent").textContent = `${percent} %`;
  }

  private hideProgress(): void {
    el<HTMLElement>("analyze-progress").hidden = true;
  }

  private async analyzeFile(file: File): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const title = file.name.replace(/\.[^.]+$/, "");
    this.setProgress("Envoi", 0);
    try {
      const { jobId, analysis } = await uploadAndAnalyze(file, {
        signal: controller.signal,
        onUploadProgress: (ratio) => this.setProgress("Envoi", ratio * 0.25, `${Math.round(ratio * 100)} % envoyé`),
        onPhase: ({ progress, phase, detail }) =>
          this.setProgress(phase, 0.25 + progress * 0.75, detail),
      });
      this.send({ type: "analysis-ready", jobId, title, artist: "", analysis });
      this.setProgress("Terminé", 1, "Spectacle prêt — calage en cours");
      window.setTimeout(() => this.hideProgress(), 2500);
    } catch (error) {
      if (error instanceof ApiError && error.code === "aborted") {
        this.hideProgress();
        return;
      }
      this.fail(error);
    }
  }

  private async resolve(title: string, artist: string): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setProgress("Recherche", 0, title);
    try {
      const { jobId, analysis } = await resolveAndAnalyze(title, artist, undefined, {
        signal: controller.signal,
        onPhase: ({ progress, phase, detail }) => this.setProgress(phase, progress, detail),
      });
      this.send({ type: "analysis-ready", jobId, title, artist, analysis });
      this.setProgress("Terminé", 1, "Spectacle prêt — calage en cours");
      window.setTimeout(() => this.hideProgress(), 2500);
    } catch (error) {
      if (error instanceof ApiError && error.code === "aborted") {
        this.hideProgress();
        return;
      }
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.setProgress("Échec", 1, message);
    window.setTimeout(() => this.hideProgress(), 6000);
  }
}

function boot(): void {
  new Dashboard();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
