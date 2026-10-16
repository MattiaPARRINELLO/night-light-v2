/**
 * Tableau de bord de Night Light.
 *
 * Écran de contrôle complet : audio en direct, synchronisation, morceau en cours
 * (analyse complète), état du programme, rendu visuel et réglages.
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
import type { Analysis, Point } from "../types";

const HISTORY_MS = 60_000;
const SAMPLE_MS = 250;
const LINK_TIMEOUT_MS = 3000;

interface Sample {
  at: number;
  rms: number;
  energy: number;
  bass: number;
  mid: number;
  high: number;
  transient: number;
  showMs: number;
  playerMs: number;
  driftMs: number;
  correlation: number | null;
  liveFps: number;
  showFps: number;
  liveQuality: number;
  showQuality: number;
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

function fmtTime(value: number): string {
  const minutes = Math.floor(value / 60);
  const secondsPart = value % 60;
  return `${minutes}:${secondsPart.toFixed(1).padStart(4, "0")}`;
}

function sampleCurve(curve: Point[], timeValue: number): number {
  if (curve.length === 0) return 0;
  if (timeValue <= curve[0]![0]) return curve[0]![1];
  const last = curve[curve.length - 1]!;
  if (timeValue >= last[0]) return last[1];
  for (let index = 0; index < curve.length - 1; index++) {
    const point = curve[index]!;
    const next = curve[index + 1]!;
    if (timeValue >= point[0] && timeValue <= next[0]) {
      const factor = (timeValue - point[0]) / Math.max(next[0] - point[0], 1e-6);
      return point[1] + (next[1] - point[1]) * factor;
    }
  }
  return 0;
}



/** Courbe simple. */
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

/** Spectre en barres. */
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

  ctx.fillStyle = `rgba(255,255,255,${0.12 + state.audio.energy * 0.35})`;
  ctx.fillRect(0, h - 2 - state.audio.energy * (h - 20), w, 1.5);
}

/** Historique multi-courbes. */
function drawHistory(canvas: HTMLCanvasElement, samples: Sample[]): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // grilles
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  for (let i = 1; i < 4; i++) {
    const y = (h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (samples.length < 2) return;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const timeSpan = Math.max(last.at - first.at, 1);

  const draw = (pick: (sample: Sample) => number, color: string, width: number): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    samples.forEach((sample, index) => {
      const x = ((sample.at - first.at) / timeSpan) * w;
      const value = Math.min(1, Math.max(0, pick(sample)));
      const y = h - value * (h - 4) - 2;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  draw((sample) => sample.bass, "rgba(120, 210, 255, 0.55)", 1.2);
  draw((sample) => sample.mid, "rgba(180, 150, 255, 0.55)", 1.2);
  draw((sample) => sample.high, "rgba(255, 170, 120, 0.55)", 1.2);
  draw((sample) => sample.energy, "rgba(255, 230, 140, 0.85)", 2);
  draw((sample) => sample.rms, "#7fd7ff", 2);
}

/** Analyse musicale complète. */
function drawTrack(
  canvas: HTMLCanvasElement,
  analysis: Analysis | null,
  state: ShowState,
): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // fond
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, "rgba(15, 22, 40, 0.6)");
  gradient.addColorStop(1, "rgba(8, 12, 22, 0.6)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  if (analysis === null) {
    ctx.fillStyle = "rgba(200, 210, 235, 0.72)";
    ctx.font = "15px system-ui, sans-serif";
    const message =
      state.analysis === null
        ? "Aucune analyse chargée — dépose un morceau ou lance une recherche."
        : "Analyse complète en cours de réception depuis l'écran de show…";
    ctx.fillText(message, 20, h / 2);
    return;
  }

  const duration = Math.max(analysis.duration, 0.001);
  const left = 40;
  const right = w - 24;
  const top = 24;
  const bottom = h - 42;
  const usable = right - left;
  const px = (secondsValue: number): number => left + (secondsValue / duration) * usable;

  // grille horizontale + repères
  ctx.font = "10px ui-monospace, monospace";
  for (const level of [0, 0.25, 0.5, 0.75, 1]) {
    const y = bottom - level * (bottom - top);
    ctx.strokeStyle = level === 0 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(160, 178, 210, 0.55)";
    ctx.fillText(level.toFixed(2), 6, y + 3);
  }

  // sections colorées
  const sectionColor: Record<string, string> = {
    calme: "rgba(90, 140, 220, 0.22)",
    montee: "rgba(255, 180, 90, 0.24)",
    intense: "rgba(255, 100, 140, 0.28)",
    descente: "rgba(150, 200, 160, 0.22)",
    silence: "rgba(255, 255, 255, 0.06)",
  };
  for (const section of analysis.sections) {
    const x1 = px(section.start);
    const x2 = px(section.end);
    ctx.fillStyle = sectionColor[section.label] ?? "rgba(120,180,255,0.15)";
    ctx.fillRect(x1, top, Math.max(1, x2 - x1), bottom - top);
    // séparateur
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.strokeRect(x1, top, Math.max(1, x2 - x1), bottom - top);
    // label
    ctx.fillStyle = "rgba(230,235,255,0.7)";
    ctx.font = "10px system-ui, sans-serif";
    const kind = section.kind ?? section.label;
    ctx.save();
    ctx.translate(x1 + 4, top + 12);
    ctx.fillText(kind, 0, 0);
    ctx.restore();
  }

  // Courbes : on décime à la largeur utile pour rester fluide même sur une
  // analyse longue (des dizaines de milliers de points).
  const plotCurve = (data: Point[], color: string, width: number): void => {
    if (data.length < 2) return;
    const step = Math.max(1, Math.ceil(data.length / Math.max(2, usable)));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let started = false;
    for (let index = 0; index < data.length; index += step) {
      const [t, value] = data[index]!;
      const x = px(t);
      const y = bottom - value * (bottom - top);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    const [lastT, lastValue] = data[data.length - 1]!;
    ctx.lineTo(px(lastT), bottom - lastValue * (bottom - top));
    ctx.stroke();
  };

  plotCurve(analysis.bass, "rgba(120,210,255,0.7)", 1.4);
  plotCurve(analysis.mid, "rgba(180,150,255,0.62)", 1.4);
  plotCurve(analysis.high, "rgba(255,170,120,0.62)", 1.4);
  ctx.save();
  ctx.shadowColor = "rgba(255,217,138,0.75)";
  ctx.shadowBlur = 12;
  plotCurve(analysis.energy, "#ffd98a", 3);
  ctx.restore();

  // beats (décimés si nécessaire)
  const beatStep = Math.max(1, Math.ceil(analysis.beats.length / 900));
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  for (let index = 0; index < analysis.beats.length; index += beatStep) {
    const x = px(analysis.beats[index]!);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }

  // onsets (décimés si nécessaire)
  const onsetStep = Math.max(1, Math.ceil(analysis.onsets.length / 900));
  ctx.fillStyle = "rgba(120,210,255,0.45)";
  for (let index = 0; index < analysis.onsets.length; index += onsetStep) {
    const x = px(analysis.onsets[index]!);
    ctx.beginPath();
    ctx.arc(x, bottom + 4, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // builds : flèches
  for (const build of analysis.builds) {
    const x1 = px(build.start);
    const x2 = px(build.end);
    const y = top - 8;
    ctx.strokeStyle = `rgba(255,140,180,${0.3 + build.strength * 0.6})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y);
    ctx.lineTo(x2 - 5, y - 4);
    ctx.lineTo(x2 - 5, y + 4);
    ctx.closePath();
    ctx.fillStyle = `rgba(255,140,180,${0.3 + build.strength * 0.6})`;
    ctx.fill();
  }

  // axe temps
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, bottom + 10);
  ctx.lineTo(right, bottom + 10);
  ctx.stroke();
  ctx.fillStyle = "rgba(200,210,235,0.5)";
  ctx.font = "10px system-ui, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const t = (duration * i) / 4;
    const x = px(t);
    ctx.fillText(fmtTime(t), x - 14, bottom + 24);
  }

  // curseur position show
  if (state.analysis !== null) {
    const positionSec = state.sync.showMs / 1000;
    if (positionSec >= 0 && positionSec <= duration) {
      const x = px(positionSec);
      ctx.strokeStyle = "#8ff0c4";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, top - 14);
      ctx.lineTo(x, bottom + 6);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#8ff0c4";
      ctx.fillText("show", x + 4, top - 14);
    }
  }
}

/** Courbe render activité. */
function drawRender(canvas: HTMLCanvasElement, samples: Sample[]): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (samples.length < 2) return;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const span = Math.max(last.at - first.at, 1);
  ctx.strokeStyle = "rgba(160, 130, 255, 0.75)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  samples.forEach((sample, index) => {
    const x = ((sample.at - first.at) / span) * w;
    const y = h - sample.rms * h;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

class Dashboard {
  private readonly link = new ControlLink();
  private state: ShowState = emptyShowState();
  private readonly limits = new Map<string, Limits>();
  private samples: Sample[] = [];
  private lastSampleAt = 0;
  private controller: AbortController | null = null;
  private analysis: Analysis | null = null;
  private analysisTitle = "";
  private analysisArtist = "";
  private sectionsSource: Analysis | null = null;
  private lastAnalysisRequestAt = 0;

  constructor() {
    this.link.onMessage((message) => {
      if (message.analysisPayload !== undefined) {
        const payload = message.analysisPayload;
        this.analysis = payload.analysis;
        this.analysisTitle = payload.title;
        this.analysisArtist = payload.artist;
        this.sectionsSource = null;
        this.render();
        return;
      }
      if (message.state === undefined) return;
      this.state = message.state;
      // Le résumé ne contient pas les courbes : on réclame l'analyse complète
      // dès qu'un morceau est actif et qu'on ne l'a pas encore localement (par
      // exemple après un rechargement du dashboard).
      this.requestAnalysisIfNeeded();
      this.render();
      this.sample();
    });
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
      el<HTMLElement>("prog-limits").textContent =
        `${Math.round(health.limits.maxFileBytes / 1048576)} Mo · ${health.limits.maxDurationSec} s`;
    } catch {
      el<HTMLElement>("limits-note").textContent = "Limites inconnues (serveur injoignable).";
      el<HTMLElement>("prog-limits").textContent = "serveur injoignable";
    }
  }

  /** Réclame au show l'analyse complète si on ne l'a pas ou qu'elle a changé. */
  private requestAnalysisIfNeeded(): void {
    const remote = this.state.analysis;
    if (remote === null) return;
    // Un morceau différent de celui qu'on a localement (chargé depuis le show,
    // par MPRIS, ou après un rechargement) : on jette le graphe périmé.
    if (this.analysis !== null) {
      const localKey = `${this.analysisTitle}|${this.analysis.duration.toFixed(2)}`;
      const remoteKey = `${remote.title}|${remote.durationSec.toFixed(2)}`;
      if (localKey !== remoteKey) {
        this.analysis = null;
        this.analysisTitle = "";
        this.analysisArtist = "";
        this.sectionsSource = null;
      }
    }
    if (this.analysis !== null) return;
    const now = Date.now();
    if (now - this.lastAnalysisRequestAt < 3000) return;
    this.lastAnalysisRequestAt = now;
    this.send({ type: "request-analysis" });
  }

  private checkLink(): void {
    const alive = this.state.at > 0 && Date.now() - this.state.at < LINK_TIMEOUT_MS;
    const pill = el<HTMLElement>("link-pill");
    pill.textContent = alive ? "Show connecté" : "Show hors ligne";
    pill.classList.toggle("pill-on", alive);
    pill.classList.toggle("pill-off", !alive);
    el<HTMLButtonElement>("btn-force-show").disabled = this.state.analysis === null && this.analysis === null;
  }

  private sample(): void {
    const now = Date.now();
    if (now - this.lastSampleAt < SAMPLE_MS) return;
    this.lastSampleAt = now;
    this.samples.push({
      at: now,
      rms: this.state.audio.rms,
      energy: this.state.audio.energy,
      bass: this.state.audio.bass,
      mid: this.state.audio.mid,
      high: this.state.audio.high,
      transient: this.state.audio.transient,
      showMs: this.state.sync.showMs,
      playerMs: this.state.sync.playerMs,
      driftMs: this.state.sync.driftMs,
      correlation: this.state.sync.correlation,
      liveFps: this.state.render.liveFps,
      showFps: this.state.render.showFps,
      liveQuality: this.state.render.liveQuality,
      showQuality: this.state.render.quality,
    });
    this.samples = this.samples.filter((sample) => now - sample.at <= HISTORY_MS);
  }

  private render(): void {
    const state = this.state;
    const sync = state.sync;

    el<HTMLElement>("kpi-mode").textContent = MODE_LABELS[state.mode];
    el<HTMLElement>("kpi-screen").textContent = `écran : ${SCREEN_LABELS[state.screen]}`;
    el<HTMLElement>("screen-pill").textContent = SCREEN_LABELS[state.screen];

    const stages = ["drop", "analysis", "show", "live"];
    for (const stage of stages) {
      const node = document.getElementById(`stage-${stage}`);
      if (node === null) continue;
      node.classList.remove("is-active", "is-done");
      let active = false;
      if (stage === "drop") active = state.screen === "drop";
      else if (stage === "analysis") active = state.screen === "analysis";
      else if (stage === "show") active = state.screen === "show" && state.mode !== "live" && state.mode !== "paused";
      else if (stage === "live") active = state.mode === "live" || state.mode === "paused";
      node.classList.toggle("is-active", active);
    }
    el<HTMLElement>("kpi-capture").textContent = state.capture.open ? state.capture.state : "fermée";
    el<HTMLElement>("kpi-capture-note").textContent =
      state.capture.source === "" ? `${state.capture.messages} messages` : state.capture.source;

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

    // KPI morceau
    if (this.analysis !== null) {
      el<HTMLElement>("kpi-tempo").textContent = this.analysis.tempo.toFixed(1);
      el<HTMLElement>("kpi-duration").textContent = fmtTime(this.analysis.duration);
      el<HTMLElement>("kpi-time-sections").textContent = `${this.analysis.beats.length} · ${this.analysis.sections.length}`;
      el<HTMLElement>("kpi-time-sections-note").textContent = `${fmtTime(this.analysis.duration)} · période ${this.analysis.beatPeriod.toFixed(3)} s`;
      el<HTMLElement>("kpi-build-onset").textContent = `${this.analysis.builds.length} · ${this.analysis.onsets.length}`;
      el<HTMLElement>("kpi-build-onset-note").textContent = `${this.analysis.energy.length} points d'énergie`;
    } else if (state.analysis !== null) {
      el<HTMLElement>("kpi-tempo").textContent = state.analysis.tempo.toFixed(1);
      el<HTMLElement>("kpi-duration").textContent = fmtTime(state.analysis.durationSec);
      el<HTMLElement>("kpi-time-sections").textContent = `${state.analysis.beats} · ${state.analysis.sections}`;
      el<HTMLElement>("kpi-time-sections-note").textContent = `${fmtTime(state.analysis.durationSec)}`;
      el<HTMLElement>("kpi-build-onset").textContent = `${state.analysis.builds} · —`;
      el<HTMLElement>("kpi-build-onset-note").textContent = "analyse résumée côté show";
    } else {
      el<HTMLElement>("kpi-tempo").textContent = "—";
      el<HTMLElement>("kpi-duration").textContent = "—";
      el<HTMLElement>("kpi-time-sections").textContent = "—";
      el<HTMLElement>("kpi-time-sections-note").textContent = "aucune analyse";
      el<HTMLElement>("kpi-build-onset").textContent = "—";
      el<HTMLElement>("kpi-build-onset-note").textContent = "—";
    }

    // audio
    el<HTMLElement>("audio-rate").textContent = state.capture.open
      ? `${state.capture.rate.toFixed(1)} msg/s`
      : "capture fermée";
    if (!state.capture.open) el<HTMLElement>("audio-rate").classList.add("is-off");
    else el<HTMLElement>("audio-rate").classList.remove("is-off");

    el<HTMLElement>("val-rms").textContent = state.audio.rms.toFixed(3);
    el<HTMLElement>("val-energy").textContent = state.audio.energy.toFixed(3);
    el<HTMLElement>("val-bass").textContent = state.audio.bass.toFixed(2);
    el<HTMLElement>("val-mid").textContent = state.audio.mid.toFixed(2);
    el<HTMLElement>("val-high").textContent = state.audio.high.toFixed(2);
    el<HTMLElement>("val-transient").textContent = state.audio.transient.toFixed(3);
    el<HTMLElement>("val-rms-smooth").textContent = state.smooth.rms.toFixed(3);
    el<HTMLElement>("val-energy-smooth").textContent = state.smooth.energy.toFixed(3);

    const meter = (id: string, value: number): void => {
      const node = document.getElementById(id);
      if (node === null) return;
      const clipped = Math.min(1, Math.max(0, value));
      node.style.width = `${(clipped * 100).toFixed(0)}%`;
      node.parentElement?.classList.toggle("is-hot", clipped > 0.82);
    };
    meter("meter-rms", state.audio.rms);
    meter("meter-energy", state.audio.energy);
    meter("meter-bass", state.audio.bass);
    meter("meter-mid", state.audio.mid);
    meter("meter-high", state.audio.high);
    meter("meter-transient", state.audio.transient);

    el<HTMLElement>("capture-state").textContent = state.capture.state || (state.capture.open ? "ouverte" : "fermée");
    el<HTMLElement>("capture-source").textContent = state.capture.source || "—";
    el<HTMLElement>("capture-messages").textContent = String(state.capture.messages);
    el<HTMLElement>("capture-last").textContent =
      state.capture.lastAt > 0 ? new Date(state.capture.lastAt).toLocaleTimeString("fr-FR") : "—";
    el<HTMLElement>("prog-capture").textContent = state.capture.open
      ? `${state.capture.state} · ${state.capture.rate.toFixed(1)} msg/s`
      : "fermée";

    // synchronisation
    el<HTMLElement>("sync-source").textContent = sync.source === "" ? "aucune source" : sync.source;
    el<HTMLElement>("sync-player").textContent = seconds(sync.playerMs);
    el<HTMLElement>("sync-show").textContent = seconds(sync.showMs);
    el<HTMLElement>("sync-drift").textContent = signed(sync.driftMs);
    el<HTMLElement>("sync-latency").textContent = `${sync.latencyMs} ms`;
    el<HTMLElement>("sync-attempts").textContent = String(sync.attempts);
    el<HTMLElement>("sync-correlation").textContent =
      sync.correlation === null ? "—" : sync.correlation.toFixed(3);
    el<HTMLElement>("sync-expected").textContent = sync.expectedTitle || "—";
    el<HTMLElement>("sync-read").textContent = sync.playerTitle || "—";
    el<HTMLElement>("sync-match").textContent = sync.match || "—";

    // réglages
    const reduced = el<HTMLInputElement>("chk-reduced");
    const noflash = el<HTMLInputElement>("chk-noflash");
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

    // canvases
    drawSpectrum(el<HTMLCanvasElement>("audio-canvas"), state);
    drawHistory(el<HTMLCanvasElement>("rms-canvas"), this.samples);
    drawSeries(el<HTMLCanvasElement>("drift-canvas"), this.samples, (sample) => sample.driftMs, "#ffb86b", {
      min: -1500,
      max: 1500,
      zero: true,
    });

    drawSeries(el<HTMLCanvasElement>("spark-rms"), this.samples, (sample) => sample.rms, "#7fd7ff", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-energy"), this.samples, (sample) => sample.energy, "#ffd98a", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-bass"), this.samples, (sample) => sample.bass, "#78d2ff", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-mid"), this.samples, (sample) => sample.mid, "#b496ff", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-high"), this.samples, (sample) => sample.high, "#ffaa78", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-transient"), this.samples, (sample) => sample.transient, "#ff8ca0", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-drift"), this.samples, (sample) => Math.abs(sample.driftMs) / 1500, "#ffb86b", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-corr"), this.samples, (sample) => sample.correlation ?? 0.5, "#8ff0c4", { max: 1 });

    drawRender(el<HTMLCanvasElement>("render-canvas"), this.samples);
    drawSeries(el<HTMLCanvasElement>("render-spark"), this.samples, (sample) => sample.showQuality, "#a082ff", { max: 1 });


    // morceau en cours
    const trackTitle = el<HTMLElement>("track-title");
    const trackArtist = el<HTMLElement>("track-artist");
    const trackStatus = el<HTMLElement>("track-status");
    if (this.analysis !== null) {
      trackTitle.textContent = this.analysisTitle || "Morceau analysé";
      trackArtist.textContent =
        this.analysisArtist === "" ? `${this.analysis.beats.length} temps · ${this.analysis.onsets.length} attaques` : this.analysisArtist;
      trackStatus.textContent = "analyse locale complète";
    } else if (state.analysis !== null) {
      trackTitle.textContent = state.analysis.title || "Morceau chargé";
      trackArtist.textContent = `${state.analysis.beats} temps · ${state.analysis.builds} montées · ${state.analysis.sections} sections`;
      trackStatus.textContent = state.screen === "analysis" ? "analyse en cours" : (MODE_LABELS[state.mode]);
    } else {
      trackTitle.textContent = "Aucun morceau chargé";
      trackArtist.textContent = "Dépose un fichier ou recherche par titre";
      trackStatus.textContent = "en attente";
    }

    el<HTMLElement>("track-stats").innerHTML = this.analysis
      ? [
          `<span>Durée ${fmtTime(this.analysis.duration)}</span>`,
          `<span>Tempo ${this.analysis.tempo.toFixed(1)} BPM</span>`,
          `<span>Temps ${this.analysis.beats.length}</span>`,
          `<span>Attaques ${this.analysis.onsets.length}</span>`,
          `<span>Sections ${this.analysis.sections.length}</span>`,
          `<span>Montées ${this.analysis.builds.length}</span>`,
          `<span>Période ${this.analysis.beatPeriod.toFixed(3)} s</span>`,
        ].join("")
      : state.analysis
        ? [
            `<span>Durée ${fmtTime(state.analysis.durationSec)}</span>`,
            `<span>Tempo ${state.analysis.tempo.toFixed(1)} BPM</span>`,
            `<span>Temps ${state.analysis.beats}</span>`,
            `<span>Sections ${state.analysis.sections}</span>`,
            `<span>Montées ${state.analysis.builds}</span>`,
          ].join("")
        : "";

    // position dans le morceau
    const trackPositionSec = Math.max(0, state.sync.showMs / 1000);

    // liste des sections (reconstruite seulement quand l'analyse change)
    const sectionHost = el<HTMLElement>("track-sections");
    if (this.analysis !== this.sectionsSource) {
      this.sectionsSource = this.analysis;
      sectionHost.innerHTML =
        this.analysis === null
          ? ""
          : this.analysis.sections
              .map((section) => {
                const kind = section.kind ?? section.label;
                const group = section.group ? ` · groupe ${section.group}` : "";
                const occurrence = section.occurrence ? ` (n°${section.occurrence})` : "";
                return `<div class="section-chip"><span class="chip-kind">${kind}${occurrence}</span><span class="chip-range">${fmtTime(section.start)} → ${fmtTime(section.end)} · énergie ${section.energy.toFixed(2)}${group}</span></div>`;
              })
              .join("");
    }
    if (this.analysis !== null) {
      const currentIndex = this.analysis.sections.findIndex(
        (entry) => trackPositionSec >= entry.start && trackPositionSec < entry.end,
      );
      Array.from(sectionHost.children).forEach((child, index) => {
        child.classList.toggle("is-current", index === currentIndex);
      });
    }

    drawTrack(el<HTMLCanvasElement>("track-canvas"), this.analysis, state);

    // lecture en cours dans le morceau
    if (this.analysis !== null) {
      const duration = Math.max(this.analysis.duration, 0.001);
      const percent = Math.min(100, (trackPositionSec / duration) * 100);
      const section = this.analysis.sections.find((entry) => trackPositionSec >= entry.start && trackPositionSec < entry.end) ?? null;
      const energyNow = sampleCurve(this.analysis.energy, trackPositionSec);
      const nextBuild = this.analysis.builds.find((entry) => entry.end >= trackPositionSec) ?? null;
      el<HTMLElement>("now-time").textContent = `Position ${fmtTime(trackPositionSec)} / ${fmtTime(this.analysis.duration)}`;
      el<HTMLElement>("now-percent").textContent = `${percent.toFixed(1)} % du morceau`;
      el<HTMLElement>("now-section").textContent = section ? `Section ${section.kind ?? section.label} (${(section.energy * 100).toFixed(0)} %)` : "Section inconnue";
      el<HTMLElement>("now-energy").textContent = `Énergie actuelle ${energyNow.toFixed(3)}`;
      el<HTMLElement>("now-build").textContent = nextBuild
        ? `Prochaine montée dans ${fmtTime(Math.max(0, nextBuild.start - trackPositionSec))} (force ${(nextBuild.strength * 100).toFixed(0)} %)`
        : "Aucune montée restante";
      el<HTMLElement>("track-progress-fill").style.width = `${percent}%`;

      const beatPeriod = this.analysis.beatPeriod > 0.05 ? this.analysis.beatPeriod : 0.5;
      const pulse = 1 - ((trackPositionSec % beatPeriod) / beatPeriod);
      const beat = el<HTMLElement>("beat-pulse");
      beat.style.opacity = String(0.35 + pulse * 0.65);
      beat.style.transform = `scale(${0.8 + pulse * 0.6})`;

      // prochains événements
      const events: string[] = [];
      for (const build of this.analysis.builds.filter((entry) => entry.end >= trackPositionSec).slice(0, 3)) {
        events.push(
          `<span class="upcoming-item is-build">Montée dans ${fmtTime(Math.max(0, build.start - trackPositionSec))} → impact dans ${fmtTime(Math.max(0, build.end - trackPositionSec))} · force ${(build.strength * 100).toFixed(0)} %</span>`,
        );
      }
      for (const future of this.analysis.sections.filter((entry) => entry.start > trackPositionSec).slice(0, 3)) {
        events.push(
          `<span class="upcoming-item">${future.kind ?? future.label} dans ${fmtTime(future.start - trackPositionSec)} · énergie ${(future.energy * 100).toFixed(0)} %</span>`,
        );
      }
      el<HTMLElement>("upcoming").innerHTML = events.length > 0 ? events.join("") : `<span class="upcoming-item is-muted">Fin du morceau proche</span>`;
    } else {
      el<HTMLElement>("now-time").textContent = "Position —";
      el<HTMLElement>("now-percent").textContent = "—";
      el<HTMLElement>("now-section").textContent = "Aucune analyse";
      el<HTMLElement>("now-energy").textContent = "—";
      el<HTMLElement>("now-build").textContent = "—";
      el<HTMLElement>("track-progress-fill").style.width = "0%";
      el<HTMLElement>("upcoming").innerHTML = "";
      const beat = el<HTMLElement>("beat-pulse");
      beat.style.opacity = "0.3";
      beat.style.transform = "scale(0.8)";
    }

    // état du programme
    el<HTMLElement>("prog-screen").textContent = SCREEN_LABELS[state.screen];
    el<HTMLElement>("prog-mode").textContent = MODE_LABELS[state.mode];
    el<HTMLElement>("prog-controlled").textContent = state.controlled ? "oui (kiosque)" : "non";
    el<HTMLElement>("prog-capture").textContent = state.capture.open
      ? `${state.capture.state} · ${state.capture.rate.toFixed(1)} msg/s`
      : "fermée";
    el<HTMLElement>("prog-error").textContent = state.error ? `${state.error.title} — ${state.error.message}` : "aucune";
    el<HTMLElement>("prog-notice").textContent = state.notice ? state.notice.text : "—";
    el<HTMLElement>("prog-debug").textContent = state.debugOverlay ? "overlay actif" : "inactif";
    if (!this.limits.has("health")) el<HTMLElement>("prog-limits").textContent = "—";

    // rendu visuel
    el<HTMLElement>("render-live-fps").textContent = state.render.liveFps.toFixed(1);
    el<HTMLElement>("render-show-fps").textContent = state.render.showFps.toFixed(1);
    el<HTMLElement>("render-live-q").textContent = state.render.liveQuality.toFixed(2);
    el<HTMLElement>("render-show-q").textContent = state.render.quality.toFixed(2);
    el<HTMLElement>("render-live-frame").textContent = String(state.render.liveFrame);
    el<HTMLElement>("render-show-frame").textContent = String(state.render.frame);
    drawRender(el<HTMLCanvasElement>("render-canvas"), this.samples);

    // journal
    const log = el<HTMLElement>("log");
    log.textContent = state.log.length === 0 ? "Rien à signaler." : state.log.join("\n");
    el<HTMLElement>("log-count").textContent = `${state.log.length} lignes`;

    const notice = el<HTMLElement>("notice");
    if (state.notice === null) {
      notice.hidden = true;
      notice.textContent = "";
    } else {
      notice.hidden = false;
      notice.textContent = state.notice.text;
    }

    el<HTMLButtonElement>("btn-capture").textContent = state.capture.open
      ? "Couper la capture"
      : "Écouter le son du PC";

    const mode = el<HTMLElement>("mode-pill");
    mode.textContent = MODE_LABELS[state.mode];
    mode.classList.toggle("pill-mode", state.mode !== "live");
  }

  private bindControls(): void {
    const intensity = el<HTMLInputElement>("intensity");
    const flashes = el<HTMLInputElement>("flashes");
    const reduced = el<HTMLInputElement>("chk-reduced");
    const noflash = el<HTMLInputElement>("chk-noflash");
    const latency = el<HTMLInputElement>("latency");

    intensity.addEventListener("change", () => {
      const value = Number(intensity.value);
      if (Number.isFinite(value)) {
        this.send({ type: "set-settings", patch: { intensity: value / 100 } });
      }
    });
    flashes.addEventListener("change", () => {
      const value = Number(flashes.value);
      if (Number.isFinite(value)) {
        this.send({ type: "set-settings", patch: { flashes: value / 100 } });
      }
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
      this.analysis = analysis;
      this.analysisTitle = title;
      this.analysisArtist = "";
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
      this.analysis = analysis;
      this.analysisTitle = title;
      this.analysisArtist = artist;
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
