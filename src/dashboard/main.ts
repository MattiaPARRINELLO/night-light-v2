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
import type { Analysis } from "../types";
import { fmtTime, sampleCurve } from "./format";
import { TrackChart } from "./trackChart";

const HISTORY_MS = 60_000;
const SAMPLE_MS = 250;
const LINK_TIMEOUT_MS = 3000;
/** Au-delà, la capture est ouverte mais n'envoie plus rien. */
const CAPTURE_STALE_MS = 2000;

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

interface QueueStatus {
  provider: string;
  note: string;
  preload: Array<{
    key: string;
    title: string;
    artist: string;
    state: string;
    method: string;
    error: string;
  }>;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Élément manquant dans le DOM : #${id}`);
  return node as T;
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${Math.round(value)} ms`;
}

/** Écrit le texte seulement s'il change : inutile de repeindre 60 fois par seconde. */
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/**
 * Phrase de synthèse d'un panneau : une ligne, colorée selon qu'elle annonce une
 * bonne nouvelle, un doute ou un problème.
 */
function setVerdict(node: HTMLElement, text: string, tone: "good" | "warn" | "bad" | ""): void {
  setText(node, text);
  node.classList.toggle("is-good", tone === "good");
  node.classList.toggle("is-warn", tone === "warn");
  node.classList.toggle("is-bad", tone === "bad");
}

/** Section jouée à cet instant, sous forme lisible : « refrain n°2 ». */
function sectionAt(analysis: Analysis, seconds: number): string {
  const section = analysis.sections.find((entry) => seconds >= entry.start && seconds < entry.end);
  if (section === undefined) return "hors section";
  const kind = section.kind ?? section.label;
  return section.occurrence ? `${kind} n°${section.occurrence}` : kind;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Signature des compteurs d'une analyse. Deux analyses du même morceau qui ne
 * diffèrent que par leur précision (rapide puis finale) ont des compteurs
 * différents : c'est ce qui permet au dashboard de savoir qu'il doit
 * redemander les courbes.
 */
function analysisSignature(entry: {
  duration: number;
  tempo: number;
  beats: number;
  builds: number;
  sections: number;
  coverage?: [number, number] | null;
}): string {
  return [
    entry.duration.toFixed(2),
    entry.tempo.toFixed(1),
    entry.beats,
    entry.builds,
    entry.sections,
    entry.coverage ? entry.coverage.join(",") : "",
  ].join("|");
}

/** « 1 montée », « 3 montées » : un compteur qui se lit sans accroc. */
function pluriel(count: number, singulier: string, pluriels: string): string {
  return `${count} ${count > 1 ? pluriels : singulier}`;
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

/** Spectre en barres. Sans signal, des barres à zéro : plutôt qu'un faux niveau. */
function drawSpectrum(canvas: HTMLCanvasElement, state: ShowState, idle: boolean): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const bands: Array<[string, number]> = [
    ["basses", idle ? 0 : state.audio.bass],
    ["médiums", idle ? 0 : state.audio.mid],
    ["aigus", idle ? 0 : state.audio.high],
  ];
  const barWidth = w / bands.length;
  for (const [index, [label, value]] of bands.entries()) {
    const x = index * barWidth;
    const height = h * Math.min(1, Math.max(idle ? 0 : 0.04, value));
    const gradient = ctx.createLinearGradient(0, h - height, 0, h);
    gradient.addColorStop(0, `hsla(${190 + index * 55}, 85%, 66%, ${idle ? 0.3 : 0.95})`);
    gradient.addColorStop(1, `hsla(${190 + index * 55}, 85%, 45%, ${idle ? 0.18 : 0.55})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(x + barWidth * 0.14, h - height, barWidth * 0.72, height);
    ctx.fillStyle = "rgba(220,232,248,0.55)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(label, x + barWidth * 0.14, h - 4);
  }

  if (idle) {
    ctx.fillStyle = "rgba(220, 232, 248, 0.75)";
    ctx.font = "600 13px system-ui, sans-serif";
    const text = state.capture.open ? "aucun son capté" : "capture fermée";
    ctx.fillText(text, 16, 24);
    return;
  }

  ctx.fillStyle = `rgba(255,255,255,${0.12 + state.audio.energy * 0.35})`;
  ctx.fillRect(0, h - 2 - state.audio.energy * (h - 20), w, 1.5);
}

/** Historique multi-courbes. `idle` aplatit les bandes : voir `drawSpectrum`. */
function drawHistory(canvas: HTMLCanvasElement, samples: Sample[], idle: boolean): void {
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

  const flat = (value: number): number => (idle ? 0 : value);
  draw((sample) => flat(sample.bass), "rgba(120, 210, 255, 0.55)", 1.2);
  draw((sample) => flat(sample.mid), "rgba(180, 150, 255, 0.55)", 1.2);
  draw((sample) => flat(sample.high), "rgba(255, 170, 120, 0.55)", 1.2);
  draw((sample) => sample.energy, "rgba(255, 230, 140, 0.85)", 2);
  draw((sample) => sample.rms, "#7fd7ff", 2);
}

/** Images par seconde du show, mises à l'échelle sur 60 : la vraie activité du rendu. */
function drawRender(canvas: HTMLCanvasElement, samples: Sample[]): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Repère des 40 images/s, en dessous desquelles le spectacle peut saccader.
  const floor = h - (40 / 60) * h;
  ctx.strokeStyle = "rgba(255, 217, 138, 0.28)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, floor);
  ctx.lineTo(w, floor);
  ctx.stroke();
  ctx.setLineDash([]);

  if (samples.length < 2) return;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const span = Math.max(last.at - first.at, 1);
  ctx.strokeStyle = "rgba(160, 130, 255, 0.85)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  samples.forEach((sample, index) => {
    const x = ((sample.at - first.at) / span) * w;
    const y = h - Math.min(1, Math.max(0, sample.showFps / 60)) * h;
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
  /**
   * Dernier instant où une analyse a été chargée localement.
   *
   * Sert de garde avant d'effacer un graphe parce que le show n'en porte plus :
   * juste après un envoi, l'état du show peut encore décrire le morceau
   * précédent le temps d'un aller-retour.
   */
  private analysisLoadedAt = 0;
  private readonly chart: TrackChart;

  constructor() {
    // Le tracé a sa propre boucle d'animation : la position lissée qu'il produit
    // sert aussi à faire vivre l'horloge et la barre de progression.
    this.chart = new TrackChart(
      el<HTMLCanvasElement>("track-canvas"),
      el<HTMLElement>("track-plot"),
      el<HTMLElement>("track-tooltip"),
      el<HTMLButtonElement>("track-zoom"),
      (seconds) => this.updateLivePosition(seconds),
    );
    this.link.onMessage((message) => {
      if (message.analysisPayload !== undefined) {
        const payload = message.analysisPayload;
        this.analysis = payload.analysis;
        this.analysisTitle = payload.title;
        this.analysisArtist = payload.artist;
        this.analysisLoadedAt = Date.now();
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
    window.setInterval(() => void this.refreshQueue(), 2000);
    void this.loadLimits();
    this.bindControls();
    this.checkLink();
    void this.refreshQueue();
  }

  private async refreshQueue(): Promise<void> {
    try {
      const response = await fetch("/api/queue");
      if (!response.ok) return;
      const queue = (await response.json()) as QueueStatus;
      el<HTMLElement>("queue-provider").textContent = queue.provider || "MPRIS seul";
      el<HTMLElement>("queue-method").textContent =
        `Source : ${queue.provider} · ${queue.note || "—"}`;
      const list = el<HTMLElement>("queue-preload");
      if (queue.preload.length === 0) {
        list.innerHTML = "<li>Aucune piste préchargée.</li>";
        return;
      }
      list.innerHTML = queue.preload
        .map((item) => {
          const state = item.error ? `${item.state} (${item.error})` : item.state;
          return `<li>${item.title} — ${item.artist} · ${state} · ${item.method}</li>`;
        })
        .join("");
    } catch {
      // Le dashboard reste utilisable si le serveur redémarre.
    }
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
    if (remote === null) {
      // Le show ne porte plus de morceau : changement de piste (retour au direct
      // pendant la résolution), écran de dépôt. Garder le graphe précédent
      // laisserait croire que le dashboard suit encore le morceau terminé.
      const mode = this.state.mode;
      const suivant = mode === "live" || mode === "syncing" || mode === "lost";
      if (suivant && Date.now() - this.analysisLoadedAt > 2000) {
        this.analysis = null;
        this.analysisTitle = "";
        this.analysisArtist = "";
        this.sectionsSource = null;
      }
      return;
    }
    // Un morceau différent de celui qu'on a localement (chargé depuis le show,
    // par MPRIS, ou après un rechargement) : on jette le graphe périmé.
    if (this.analysis !== null) {
      const local = this.analysis;
      const localKey = `${this.analysisTitle}|${local.duration.toFixed(2)}`;
      const remoteKey = `${remote.title}|${remote.durationSec.toFixed(2)}`;
      if (localKey !== remoteKey) {
        this.analysis = null;
        this.analysisTitle = "";
        this.analysisArtist = "";
        this.sectionsSource = null;
      } else {
        // Même morceau : on compare la version d'analyse. Une analyse rapide
        // déjà affichée ne doit jamais écraser une analyse finale, et l'arrivée
        // de l'analyse finale doit remplacer les courbes rapides.
        const localPartial = local.coverage !== undefined;
        const remotePartial = remote.coverage !== null;
        const localSignature = analysisSignature({
          duration: local.duration,
          tempo: local.tempo,
          beats: local.beats.length,
          builds: local.builds.length,
          sections: local.sections.length,
          coverage: local.coverage ?? null,
        });
        const remoteSignature = analysisSignature({
          duration: remote.durationSec,
          tempo: remote.tempo,
          beats: remote.beats,
          builds: remote.builds,
          sections: remote.sections,
          coverage: remote.coverage,
        });
        const stale =
          localPartial === remotePartial ? localSignature !== remoteSignature : !remotePartial;
        if (!stale) return;
        // On garde l'ancienne analyse à l'écran pendant l'aller-retour : elle
        // décrit le même morceau, seule sa précision change.
      }
    }
    const now = Date.now();
    if (now - this.lastAnalysisRequestAt < 3000) return;
    this.lastAnalysisRequestAt = now;
    this.send({ type: "request-analysis" });
  }

  private checkLink(): void {
    const seen = this.state.at > 0;
    const age = seen ? Date.now() - this.state.at : null;
    const alive = seen && age !== null && age < LINK_TIMEOUT_MS;

    setText(el<HTMLElement>("link-pill"), alive ? "Show connecté" : "Show hors ligne");
    setText(
      el<HTMLElement>("sb-link-note"),
      !seen
        ? "aucun signe reçu"
        : alive
          ? "à jour"
          : `dernier signe il y a ${Math.round((age ?? 0) / 1000)} s`,
    );
    const link = el<HTMLElement>("sb-link");
    link.classList.toggle("is-on", alive);
    link.classList.toggle("is-off", !alive);

    // Une liaison perdue ne doit pas se lire comme un dashboard en panne : on dit
    // explicitement que tout ce qui est affiché est figé, et depuis quand.
    const stale = el<HTMLElement>("alert-stale");
    stale.hidden = !(seen && !alive);
    if (!stale.hidden) {
      setText(
        el<HTMLElement>("stale-text"),
        `L'écran de show ne répond plus depuis ${Math.round((age ?? 0) / 1000)} s : tout ce qui suit est la dernière valeur reçue.`,
      );
    }
    this.refreshAlerts();

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

    // ---- bande d'état : cinq faits ; le reste de la page ne fait que détailler
    setText(el<HTMLElement>("kpi-mode"), MODE_LABELS[state.mode]);
    setText(el<HTMLElement>("kpi-screen"), `écran : ${SCREEN_LABELS[state.screen]}`);
    el<HTMLElement>("sb-mode").classList.toggle("is-mode-active", state.mode !== "live");

    const trackPositionSec = Math.max(0, sync.showMs / 1000);
    const positionSec = this.analysis !== null ? this.analysis.duration : state.analysis?.durationSec ?? null;
    const shownPosition = positionSec === null ? trackPositionSec : Math.min(trackPositionSec, positionSec);
    setText(
      el<HTMLElement>("sb-position-value"),
      positionSec === null ? `${fmtTime(shownPosition)} / —` : `${fmtTime(shownPosition)} / ${fmtTime(positionSec)}`,
    );
    const place =
      this.analysis === null
        ? state.analysis === null
          ? "aucun morceau analysé"
          : state.analysis.title
        : sectionAt(this.analysis, shownPosition);
    setText(
      el<HTMLElement>("sb-position-note"),
      positionSec === null ? place : `${((shownPosition / positionSec) * 100).toFixed(1)} % · ${place}`,
    );

    const live = state.mode === "live";
    const driftAbs = Math.abs(sync.driftMs);
    setText(el<HTMLElement>("sb-drift-value"), live ? "—" : signed(sync.driftMs));
    setText(
      el<HTMLElement>("sb-drift-note"),
      live ? "rien à caler en Live" : `tolérance 150 ms · latence ${sync.latencyMs} ms`,
    );
    const sbDrift = el<HTMLElement>("sb-drift");
    sbDrift.classList.toggle("is-good", !live && driftAbs <= 150);
    sbDrift.classList.toggle("is-warn", !live && driftAbs > 150 && driftAbs < 1500);
    sbDrift.classList.toggle("is-bad", !live && driftAbs >= 1500);

    const captureStale =
      state.capture.open && state.capture.lastAt > 0 && Date.now() - state.capture.lastAt > CAPTURE_STALE_MS;
    const silence = state.capture.open && !captureStale && state.audio.rms < 0.004;
    /** Rien n'arrive du PC : les jauges et le spectre doivent le montrer. */
    const idle = !state.capture.open || silence;
    setText(el<HTMLElement>("sb-capture-value"), state.capture.open ? "active" : "fermée");
    setText(
      el<HTMLElement>("sb-capture-note"),
      state.capture.open
        ? silence
          ? "silence : rien n'arrive du PC"
          : `${state.capture.rate.toFixed(1)} messages/s`
        : "le show n'écoute pas le son du PC",
    );
    el<HTMLElement>("sb-capture").classList.toggle("is-good", state.capture.open && !captureStale && !silence);

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

    // audio
    setText(el<HTMLElement>("audio-rate"), state.capture.open ? `${state.capture.rate.toFixed(1)} messages/s` : "capture fermée");
    el<HTMLElement>("audio-rate").classList.toggle("is-off", !state.capture.open);
    if (!state.capture.open) {
      setVerdict(
        el<HTMLElement>("audio-verdict"),
        "Capture fermée : le show n'écoute pas le son du PC. Rouvre-la pour que les lumières suivent la musique.",
        "",
      );
    } else if (captureStale) {
      setVerdict(
        el<HTMLElement>("audio-verdict"),
        `Capture ouverte, mais plus rien n'arrive depuis ${Math.round((Date.now() - state.capture.lastAt) / 1000)} s.`,
        "warn",
      );
    } else if (silence) {
      setVerdict(el<HTMLElement>("audio-verdict"), "Capture ouverte, mais silence : rien n'arrive du PC.", "warn");
    } else {
      setVerdict(
        el<HTMLElement>("audio-verdict"),
        `Le son du PC arrive, ${state.capture.rate.toFixed(1)} messages par seconde.`,
        "good",
      );
    }

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
    meter("meter-bass", idle ? 0 : state.audio.bass);
    meter("meter-mid", idle ? 0 : state.audio.mid);
    meter("meter-high", idle ? 0 : state.audio.high);
    meter("meter-transient", state.audio.transient);

    el<HTMLElement>("capture-state").textContent = state.capture.state || (state.capture.open ? "ouverte" : "fermée");
    el<HTMLElement>("capture-source").textContent = state.capture.source || "—";
    el<HTMLElement>("capture-messages").textContent = String(state.capture.messages);
    el<HTMLElement>("capture-last").textContent =
      state.capture.lastAt > 0 ? new Date(state.capture.lastAt).toLocaleTimeString("fr-FR") : "—";
    el<HTMLElement>("prog-capture").textContent = state.capture.open
      ? `${state.capture.state} · ${state.capture.rate.toFixed(1)} messages/s`
      : "fermée";

    // synchronisation
    el<HTMLElement>("sync-source").textContent = sync.source === "" ? "aucune source" : sync.source;
    // En direct, il n'y a pas de position de show à comparer : garder les
    // dernières valeurs synchronisées les ferait passer pour des mesures
    // vivantes, alors qu'elles datent du morceau abandonné.
    el<HTMLElement>("sync-player").textContent = live ? "—" : fmtTime(sync.playerMs / 1000);
    el<HTMLElement>("sync-show").textContent = live ? "—" : fmtTime(sync.showMs / 1000);
    const syncDrift = el<HTMLElement>("sync-drift");
    syncDrift.textContent = live ? "—" : signed(sync.driftMs);
    syncDrift.classList.toggle("is-good", !live && driftAbs <= 150);
    syncDrift.classList.toggle("is-warn", !live && driftAbs > 150 && driftAbs < 1500);
    syncDrift.classList.toggle("is-bad", !live && driftAbs >= 1500);
    el<HTMLElement>("sync-latency").textContent = `${sync.latencyMs} ms`;
    el<HTMLElement>("sync-attempts").textContent = String(sync.attempts);
    el<HTMLElement>("sync-correlation").textContent =
      sync.correlation === null ? "—" : sync.correlation.toFixed(3);
    el<HTMLElement>("sync-expected").textContent = sync.expectedTitle || "—";
    el<HTMLElement>("sync-read").textContent = sync.playerTitle || "—";

    // Le verdict du show est déjà une phrase (« synchronisé (≤ 150 ms) ») : on la
    // remonte en tête du panneau plutôt que de la noyer en bas d'une liste.
    if (live) {
      setVerdict(el<HTMLElement>("sync-verdict"), "Rien à synchroniser : le show suit le son en direct.", "");
    } else if (state.mode === "show-local") {
      setVerdict(
        el<HTMLElement>("sync-verdict"),
        "Show local : le morceau analysé tourne, mais aucun lecteur n'est suivi.",
        "warn",
      );
    } else if (state.mode === "lost") {
      setVerdict(el<HTMLElement>("sync-verdict"), "Synchronisation perdue : le show ne retrouve plus le lecteur.", "bad");
    } else {
      setVerdict(
        el<HTMLElement>("sync-verdict"),
        sync.match === "" ? "En attente d'un signal du lecteur…" : capitalize(sync.match),
        driftAbs <= 150 ? "good" : driftAbs < 1500 ? "warn" : "bad",
      );
    }

    // réglages
    const reduced = el<HTMLInputElement>("chk-reduced");
    const noflash = el<HTMLInputElement>("chk-noflash");
    const transition = el<HTMLSelectElement>("transition-mode");
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
    if (document.activeElement !== transition) transition.value = state.settings.transition;

    // canvases
    // Sans signal, tous les relevés audio tombent à plat : un niveau de repos de
    // ⅓ affiché à côté de « silence » se lirait comme un son réel.
    const level = (fn: (sample: Sample) => number) => (sample: Sample): number => (idle ? 0 : fn(sample));
    drawSpectrum(el<HTMLCanvasElement>("audio-canvas"), state, idle);
    drawHistory(el<HTMLCanvasElement>("rms-canvas"), this.samples, idle);
    drawSeries(el<HTMLCanvasElement>("drift-canvas"), this.samples, (sample) => sample.driftMs, "#ffb86b", {
      min: -1500,
      max: 1500,
      zero: true,
    });

    drawSeries(el<HTMLCanvasElement>("spark-rms"), this.samples, level((sample) => sample.rms), "#7fd7ff", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-energy"), this.samples, level((sample) => sample.energy), "#ffd98a", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-bass"), this.samples, level((sample) => sample.bass), "#78d2ff", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-mid"), this.samples, level((sample) => sample.mid), "#b496ff", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-high"), this.samples, level((sample) => sample.high), "#ffaa78", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-transient"), this.samples, level((sample) => sample.transient), "#ff8ca0", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-drift"), this.samples, (sample) => Math.abs(sample.driftMs) / 1500, "#ffb86b", { max: 1 });
    drawSeries(el<HTMLCanvasElement>("spark-corr"), this.samples, (sample) => sample.correlation ?? 0.5, "#8ff0c4", { max: 1 });

    drawRender(el<HTMLCanvasElement>("render-canvas"), this.samples);
    drawSeries(el<HTMLCanvasElement>("render-spark"), this.samples, (sample) => sample.showQuality, "#a082ff", { max: 1 });


    // morceau en cours : titre, artiste, puis la fiche technique en une ligne
    const trackTitle = el<HTMLElement>("track-title");
    const trackArtist = el<HTMLElement>("track-artist");
    const trackStatus = el<HTMLElement>("track-status");
    const trackFacts = el<HTMLElement>("track-facts");
    const sectionCount = el<HTMLElement>("section-count");
    if (this.analysis !== null) {
      // Une analyse rapide ne couvre qu'une fenêtre du morceau : le dire évite
      // de la lire comme l'analyse définitive en attendant la finale.
      const partial = this.analysis.coverage !== undefined;
      trackTitle.textContent = this.analysisTitle || "Morceau analysé";
      trackArtist.textContent =
        this.analysisArtist === ""
          ? partial
            ? "analyse rapide : courbes partielles"
            : "analyse locale complète"
          : this.analysisArtist;
      trackStatus.textContent = partial ? "analyse rapide" : "analyse locale complète";
      trackFacts.textContent = [
        fmtTime(this.analysis.duration),
        `${this.analysis.tempo.toFixed(1)} BPM`,
        `période ${this.analysis.beatPeriod.toFixed(3)} s`,
        pluriel(this.analysis.sections.length, "section", "sections"),
        pluriel(this.analysis.beats.length, "temps fort", "temps forts"),
        pluriel(this.analysis.onsets.length, "attaque", "attaques"),
        pluriel(this.analysis.builds.length, "montée", "montées"),
      ].join(" · ");
      sectionCount.textContent = pluriel(this.analysis.sections.length, "section", "sections");
    } else if (state.analysis !== null) {
      trackTitle.textContent = state.analysis.title || "Morceau chargé";
      trackArtist.textContent = "analyse résumée : les courbes arrivent du show";
      trackStatus.textContent = state.screen === "analysis" ? "analyse en cours" : MODE_LABELS[state.mode];
      trackFacts.textContent = [
        fmtTime(state.analysis.durationSec),
        `${state.analysis.tempo.toFixed(1)} BPM`,
        pluriel(state.analysis.sections, "section", "sections"),
        pluriel(state.analysis.beats, "temps fort", "temps forts"),
        pluriel(state.analysis.builds, "montée", "montées"),
      ].join(" · ");
      sectionCount.textContent = pluriel(state.analysis.sections, "section", "sections");
    } else if (state.mode === "live" && state.sync.playerTitle.trim() !== "") {
      // Le lecteur joue un morceau que le show n'a pas encore analysé : on
      // affiche son titre plutôt que l'ancien morceau ou « aucun morceau ».
      trackTitle.textContent = state.sync.playerTitle;
      trackArtist.textContent = "le show suit le direct · analyse du lecteur en cours";
      trackStatus.textContent = "en attente d'analyse";
      trackFacts.textContent = "—";
      sectionCount.textContent = "—";
    } else {
      trackTitle.textContent = "Aucun morceau chargé";
      trackArtist.textContent = "Dépose un fichier ou cherche par titre, dans « Lancer un morceau »";
      trackStatus.textContent = "en attente";
      trackFacts.textContent = "—";
      sectionCount.textContent = "—";
    }

    const trackTimings = el<HTMLElement>("track-timings");
    if (state.timings === null) {
      trackTimings.textContent = "Chronologie : —";
    } else {
      const t = state.timings;
      const stage = (label: string, value: number | null): string =>
        `${label} ${value === null ? "—" : `+${Math.round(value)} ms`}`;
      const parts = [
        "détecté",
        stage("trouvé", t.foundMs),
        stage("téléchargé", t.downloadedMs),
        stage("partiel", t.partialMs),
        stage("analysé", t.analyzedMs),
        stage("calé", t.syncedMs),
        stage("premier frame", t.firstFrameMs),
      ];
      if (t.planMs !== null) parts.push(`plan ${Math.round(t.planMs)} ms`);
      if (t.analysisCache) parts.push("analyse en cache");
      else if (t.audioCache) parts.push("audio en cache");
      trackTimings.textContent = `Chronologie : ${parts.join(" → ")}`;
    }

    const trackPhases = el<HTMLElement>("track-phases");
    if (state.timings?.phases == null) {
      trackPhases.textContent = "Phases d’analyse : —";
    } else {
      const labels: Record<string, string> = {
        processStartImportsSec: "processus/imports",
        workerWarmupSec: "préchauffage worker",
        decodeSec: "décodage",
        resampleSec: "rééchantillonnage",
        onsetSec: "onset",
        beatTrackSec: "beat_track",
        onsetsSec: "onsets",
        stftSec: "stft",
        featuresSec: "bandes/rms",
        mfccChromaSec: "mfcc/chroma",
        curvesSec: "courbes",
        buildsSec: "montées",
        serializationMs: "sérialisation",
      };
      const entries = Object.entries(state.timings.phases)
        .filter(([, value]) => Number.isFinite(value))
        .map(([key, value]) => {
          const label = labels[key] ?? key;
          const text =
            key === "processStartImportsSec" || key.endsWith("Ms")
              ? `${Math.round(value)} ms`
              : `${(value * 1000).toFixed(0)} ms`;
          return `${label} ${text}`;
        });
      trackPhases.textContent = `Phases d’analyse : ${entries.join(" · ")}`;
    }

    // tableau des sections (reconstruit seulement quand l'analyse change)
    const sectionHost = el<HTMLElement>("track-sections");
    if (this.analysis !== this.sectionsSource) {
      this.sectionsSource = this.analysis;
      if (this.analysis === null) {
        sectionHost.innerHTML = "";
      } else {
        const head =
          `<div class="section-row is-head"><span>Rôle</span><span>Plage</span><span>Durée</span><span>Énergie moyenne</span><span>Groupe</span></div>`;
        const analysis = this.analysis;
        const rows = analysis.sections
          .map((section) => {
            const kind = section.kind ?? section.label;
            const occurrence = section.occurrence ? ` (n°${section.occurrence})` : "";
            const length = Math.max(0, section.end - section.start);
            const energy = Math.min(1, Math.max(0, section.energy));
            const group = section.group ? `groupe ${section.group}` : "—";
            return (
              `<div class="section-row">` +
              `<span class="sec-kind">${kind}${occurrence}</span>` +
              `<span class="sec-range">${fmtTime(section.start)} → ${fmtTime(section.end)}</span>` +
              `<span class="sec-len">${length.toFixed(1)} s</span>` +
              `<span class="energy-cell" title="énergie moyenne ${energy.toFixed(2)}"><i style="width:${(energy * 100).toFixed(0)}%"></i><b>${energy.toFixed(2)}</b></span>` +
              `<span class="sec-group">${group}</span>` +
              `</div>`
            );
          })
          .join("");
        sectionHost.innerHTML = head + rows;
        // Le tableau et le tracé parlent du même morceau : survoler une ligne
        // montre où se joue le passage, cliquer le cadre.
        const rowNodes = Array.from(sectionHost.querySelectorAll<HTMLElement>(".section-row:not(.is-head)"));
        rowNodes.forEach((row, index) => {
          const section = analysis.sections[index];
          if (section === undefined) return;
          const range = { start: section.start, end: section.end };
          row.addEventListener("pointerenter", () => this.chart.setHighlight(range));
          row.addEventListener("pointerleave", () => this.chart.setHighlight(null));
          row.addEventListener("click", () => {
            this.chart.focusRange(range.start, range.end);
            // Le tracé est au-dessus du tableau : on le ramène à l'écran pour
            // que le cadrage se voie.
            el<HTMLElement>("track-plot").scrollIntoView({ behavior: "smooth", block: "center" });
          });
        });
      }
    }
    if (this.analysis !== null) {
      const currentIndex = this.analysis.sections.findIndex(
        (entry) => trackPositionSec >= entry.start && trackPositionSec < entry.end,
      );
      Array.from(sectionHost.querySelectorAll(".section-row:not(.is-head)")).forEach((child, index) => {
        child.classList.toggle("is-current", index === currentIndex);
      });
    }

    this.chart.setFrame({
      analysis: this.analysis,
      showMs: state.sync.showMs,
      at: state.at,
      playing: state.mode !== "paused" && state.mode !== "lost" && state.analysis !== null,
      driftMs: state.sync.driftMs,
    });

    // lecture en cours dans le morceau : tout de suite une valeur juste, puis
    // la boucle du tracé prend le relais image par image pendant la lecture.
    this.updateLivePosition(trackPositionSec);
    if (this.analysis !== null) {
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
      el<HTMLElement>("upcoming").innerHTML = "";
    }

    // état du programme
    el<HTMLElement>("prog-screen").textContent = SCREEN_LABELS[state.screen];
    el<HTMLElement>("prog-mode").textContent = MODE_LABELS[state.mode];
    el<HTMLElement>("prog-controlled").textContent = state.controlled ? "oui, l'écran de show obéit ici" : "non";
    el<HTMLElement>("prog-capture").textContent = state.capture.open
      ? `${state.capture.state} · ${state.capture.rate.toFixed(1)} messages/s`
      : "fermée";
    el<HTMLElement>("prog-debug").textContent = state.debugOverlay ? "actif" : "inactif";
    if (!this.limits.has("health")) el<HTMLElement>("prog-limits").textContent = "—";

    // Ce qui demande une action : erreur, repli discret, liaison perdue.
    setText(el<HTMLElement>("prog-error"), state.error ? `${state.error.title} : ${state.error.message}` : "—");
    el<HTMLElement>("alert-error").hidden = state.error === null;
    setText(el<HTMLElement>("notice-text"), state.notice === null ? "—" : state.notice.text);
    el<HTMLElement>("alert-notice").hidden = state.notice === null;
    if (state.resolve === null) {
      setText(el<HTMLElement>("resolve-text"), "—");
    } else {
      const name = state.resolve.artist === ""
        ? state.resolve.title
        : `${state.resolve.title} — ${state.resolve.artist}`;
      setText(el<HTMLElement>("resolve-text"), `« ${name} » — non trouvé : ${state.resolve.detail}`);
    }
    el<HTMLElement>("alert-resolve").hidden = state.resolve === null;
    this.refreshAlerts();

    // rendu visuel
    el<HTMLElement>("render-live-fps").textContent = state.render.liveFps.toFixed(1);
    el<HTMLElement>("render-show-fps").textContent = state.render.showFps.toFixed(1);
    el<HTMLElement>("render-live-q").textContent = state.render.liveQuality.toFixed(2);
    el<HTMLElement>("render-show-q").textContent = state.render.quality.toFixed(2);
    el<HTMLElement>("render-live-frame").textContent = String(state.render.liveFrame);
    el<HTMLElement>("render-show-frame").textContent = String(state.render.frame);
    const showFps = state.render.showFps;
    const renderVerdict = el<HTMLElement>("render-verdict");
    setVerdict(
      renderVerdict,
      showFps >= 40 ? "fluide" : showFps >= 24 ? "un peu juste" : "saccadé",
      showFps >= 40 ? "good" : showFps >= 24 ? "warn" : "bad",
    );
    drawRender(el<HTMLCanvasElement>("render-canvas"), this.samples);

    // journal
    const log = el<HTMLElement>("log");
    log.textContent = state.log.length === 0 ? "Rien à signaler." : state.log.join("\n");
    el<HTMLElement>("log-count").textContent = state.log.length === 0 ? "vide" : `${state.log.length} lignes`;

    el<HTMLButtonElement>("btn-capture").textContent = state.capture.open
      ? "Couper la capture"
      : "Écouter le son du PC";
  }

  /** La zone d'alertes ne s'affiche que s'il y a quelque chose à dire. */
  private refreshAlerts(): void {
    const alerts = el<HTMLElement>("alerts");
    const any = Array.from(alerts.children).some((child) => !(child as HTMLElement).hidden);
    alerts.hidden = !any;
  }

  /**
   * Position lue dans le morceau : horloge, pourcentage, section, énergie et
   * pulsation. Appelée depuis `render()` et, pendant la lecture, à chaque image
   * du tracé — c'est ce qui fait couler l'horloge au lieu de la faire sauter.
   */
  private updateLivePosition(seconds: number): void {
    if (this.analysis === null) {
      setText(el<HTMLElement>("now-time"), "Position —");
      setText(el<HTMLElement>("now-percent"), "—");
      setText(el<HTMLElement>("now-section"), "Aucune analyse");
      setText(el<HTMLElement>("now-energy"), "—");
      setText(el<HTMLElement>("now-build"), "—");
      el<HTMLElement>("now-build").classList.remove("is-good", "is-idle");
      el<HTMLElement>("track-progress-fill").style.width = "0%";
      const beat = el<HTMLElement>("beat-pulse");
      beat.style.opacity = "0.3";
      beat.style.transform = "scale(0.8)";
      return;
    }

    const duration = Math.max(this.analysis.duration, 0.001);
    // Une position au-delà de la fin (le lecteur a dépassé le morceau) ne doit
    // pas afficher 290 % : on borne à ce qui existe.
    const position = Math.min(Math.max(0, seconds), duration);
    const percent = Math.min(100, (position / duration) * 100);
    const section = this.analysis.sections.find((entry) => position >= entry.start && position < entry.end) ?? null;
    const energyNow = sampleCurve(this.analysis.energy, position);
    const nextBuild = this.analysis.builds.find((entry) => entry.end >= position) ?? null;
    const kindLabel = section
      ? `${section.kind ?? section.label}${section.occurrence ? ` n°${section.occurrence}` : ""}`
      : "—";
    setText(el<HTMLElement>("now-time"), `${fmtTime(position)} / ${fmtTime(duration)}`);
    setText(el<HTMLElement>("now-percent"), `${percent.toFixed(1)} %`);
    setText(el<HTMLElement>("now-section"), kindLabel);
    setText(el<HTMLElement>("now-energy"), `${energyNow.toFixed(2)} / 1`);
    setText(
      el<HTMLElement>("now-build"),
      nextBuild
        ? `dans ${fmtTime(Math.max(0, nextBuild.start - position))} · force ${(nextBuild.strength * 100).toFixed(0)} %`
        : "aucune montée restante",
    );
    // Vert seulement s'il reste vraiment une montée à venir.
    const build = el<HTMLElement>("now-build");
    build.classList.toggle("is-good", nextBuild !== null);
    build.classList.toggle("is-idle", nextBuild === null);
    el<HTMLElement>("track-progress-fill").style.width = `${percent}%`;

    const beatPeriod = this.analysis.beatPeriod > 0.05 ? this.analysis.beatPeriod : 0.5;
    const pulse = 1 - ((position % beatPeriod) / beatPeriod);
    const beat = el<HTMLElement>("beat-pulse");
    beat.style.opacity = String(0.35 + pulse * 0.65);
    beat.style.transform = `scale(${0.8 + pulse * 0.6})`;
  }

  private bindControls(): void {
    // La bande d'état sert de sommaire : cliquer un fait mène au panneau qui le
    // détaille, et le fait clignoter une fois pour qu'on voie où on a atterri.
    for (const node of Array.from(document.querySelectorAll<HTMLButtonElement>(".sb[data-jump]"))) {
      node.addEventListener("click", () => {
        const target = document.getElementById(node.dataset.jump ?? "");
        if (target === null) return;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.remove("sb-flash");
        void target.offsetWidth;
        target.classList.add("sb-flash");
        window.setTimeout(() => target.classList.remove("sb-flash"), 1300);
      });
    }

    const intensity = el<HTMLInputElement>("intensity");
    const flashes = el<HTMLInputElement>("flashes");
    const reduced = el<HTMLInputElement>("chk-reduced");
    const noflash = el<HTMLInputElement>("chk-noflash");
    const transition = el<HTMLSelectElement>("transition-mode");
    const latency = el<HTMLInputElement>("latency");

    transition.addEventListener("change", () => {
      this.send({
        type: "set-settings",
        patch: { transition: transition.value === "black" ? "black" : "crossfade" },
      });
    });

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
    el<HTMLButtonElement>("track-zoom").addEventListener("click", () => this.chart.resetZoom());

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
      this.analysisLoadedAt = Date.now();
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
      const { jobId, analysis, timings } = await resolveAndAnalyze(title, artist, undefined, {
        signal: controller.signal,
        onPhase: ({ progress, phase, detail }) => this.setProgress(phase, progress, detail),
      });
      this.analysis = analysis;
      this.analysisTitle = title;
      this.analysisArtist = artist;
      this.analysisLoadedAt = Date.now();
      this.send({ type: "analysis-ready", jobId, title, artist, analysis, timings });
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
