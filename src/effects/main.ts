/**
 * Studio d'effets : galerie découverte automatiquement, scène plein cadre et
 * réglages en direct.
 *
 * Le rendu passe par le même `renderFrame` que le spectacle : seule la timeline
 * change (elle est synthétique et boucle). Un effet ajouté au moteur apparaît
 * donc dans la galerie sans modification de ce fichier.
 */

import {
  EFFECTS,
  EFFECT_CATEGORIES,
  EFFECT_DURATION_SEC,
  applyEffectLook,
  buildEffectTimeline,
  timelineKey,
  type EffectLook,
  type EffectTimeline,
  type EffectTimelineParams,
} from "../core/effects";
import { renderFrame } from "../core/render";
import type { HazeLayer, HazeTarget } from "../core/families";
import type { FamilyId, Mood, SceneRole } from "../core/show";
import type { RenderSettings } from "../types";

const STORAGE_KEY = "night-light-effects";

interface StudioState {
  family: FamilyId;
  variant: FamilyId;
  role: SceneRole;
  mood: Mood;
  hue: number;
  spread: number;
  saturation: number;
  lightness: number;
  tempo: number;
  energy: number;
  bass: number;
  high: number;
  speed: number;
  impacts: boolean;
  seed: number;
  intensity: number;
  flashes: number;
  quality: number;
  reduced: boolean;
  haze: boolean;
}

const DEFAULT_STATE: StudioState = {
  family: "beams",
  variant: "beams",
  role: "refrain",
  mood: "pulse",
  hue: 210,
  spread: 60,
  saturation: 80,
  lightness: 60,
  tempo: 120,
  energy: 70,
  bass: 55,
  high: 45,
  speed: 1,
  impacts: true,
  seed: 7,
  intensity: 100,
  flashes: 90,
  quality: 100,
  reduced: false,
  haze: true,
};

const ROLES: SceneRole[] = ["intro", "couplet", "refrain", "montee", "drop", "finale"];
const MOODS: Mood[] = ["calme", "pulse", "explosif", "aerien", "sombre"];

type NumericKey =
  | "hue"
  | "spread"
  | "saturation"
  | "lightness"
  | "tempo"
  | "energy"
  | "bass"
  | "high"
  | "speed"
  | "seed"
  | "intensity"
  | "flashes"
  | "quality";

interface RangeSpec {
  id: string;
  key: NumericKey;
  format: (value: number) => string;
}

const RANGES: RangeSpec[] = [
  { id: "fx-hue", key: "hue", format: (value) => `${Math.round(value)}°` },
  { id: "fx-spread", key: "spread", format: (value) => `${Math.round(value)}°` },
  { id: "fx-saturation", key: "saturation", format: (value) => `${Math.round(value)} %` },
  { id: "fx-lightness", key: "lightness", format: (value) => `${Math.round(value)} %` },
  { id: "fx-tempo", key: "tempo", format: (value) => `${Math.round(value)} BPM` },
  { id: "fx-energy", key: "energy", format: (value) => `${Math.round(value)} %` },
  { id: "fx-bass", key: "bass", format: (value) => `${Math.round(value)} %` },
  { id: "fx-high", key: "high", format: (value) => `${Math.round(value)} %` },
  { id: "fx-speed", key: "speed", format: (value) => `${value.toFixed(2).replace(".", ",")}×` },
  { id: "fx-intensity", key: "intensity", format: (value) => `${Math.round(value)} %` },
  { id: "fx-flashes", key: "flashes", format: (value) => `${Math.round(value)} %` },
  { id: "fx-quality", key: "quality", format: (value) => `${Math.round(value)} %` },
];

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Élément manquant dans le DOM : #${id}`);
  return node as T;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_STATE };
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...(parsed as Partial<StudioState>) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state: StudioState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Le stockage peut être plein ou refusé : le studio reste utilisable.
  }
}

/** Prépare une nappe de fumée à partir de ses deux surfaces de travail. */
function preparerNappe(canvases: readonly [HTMLCanvasElement, HTMLCanvasElement]): HazeLayer | undefined {
  const ctx = canvases[0].getContext("2d");
  const blurPass = canvases[1].getContext("2d");
  if (ctx === null || blurPass === null) return undefined;
  return { ctx, blurPass, scale: 1, used: false };
}

function dimensionnerNappe(nappe: HazeLayer, scale: number, width: number, height: number): void {
  nappe.scale = scale;
  const largeur = Math.max(1, Math.round(width * scale));
  const hauteur = Math.max(1, Math.round(height * scale));
  if (nappe.ctx.canvas.width === largeur && nappe.ctx.canvas.height === hauteur) return;
  nappe.ctx.canvas.width = largeur;
  nappe.ctx.canvas.height = hauteur;
  nappe.blurPass.canvas.width = largeur;
  nappe.blurPass.canvas.height = hauteur;
}

class Studio {
  private readonly canvas = el<HTMLCanvasElement>("fx-stage");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly stageWrap = el<HTMLElement>("fx-stage-wrap");
  private readonly gallery = el<HTMLElement>("fx-gallery");
  private readonly cards = new Map<FamilyId, HTMLButtonElement>();
  private readonly categories = new Map<string, HTMLElement>();

  private state = loadState();
  private timeline: EffectTimeline | null = null;
  private builtKey = "";
  private clock = 0;
  private paused = false;
  private fps = 60;
  private lastTs = 0;
  private frame = 0;
  private lastHud = 0;
  private toastTimer: number | null = null;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  private readonly hazeCanvases = {
    fine: [document.createElement("canvas"), document.createElement("canvas")] as const,
    large: [document.createElement("canvas"), document.createElement("canvas")] as const,
  };
  private haze: HazeTarget | undefined = undefined;

  private readonly previewTimeline: EffectTimeline;
  private readonly previewQueue: Array<{ canvas: HTMLCanvasElement; family: FamilyId; index: number }> = [];
  private previewPumping = false;

  constructor() {
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (ctx === null) throw new Error("Canvas 2D indisponible dans ce navigateur.");
    this.ctx = ctx;

    // Un aperçu commun sert à toutes les vignettes : seules la famille et la
    // teinte changent, la timeline est partagée.
    this.previewTimeline = buildEffectTimeline({
      tempo: 120,
      energy: 0.78,
      bass: 0.6,
      high: 0.5,
      impacts: true,
      seed: 11,
    });

    this.buildVariantOptions();
    this.buildGallery();
    this.bindControls();
    this.bindActions();
    this.bindKeyboard();
    this.applyStateToDom();
    this.selectFamily(this.state.family, { reset: true, silent: true });
    this.schedulePreviews();

    const observer = new ResizeObserver(() => this.resize());
    observer.observe(this.stageWrap);
    this.resize();
    requestAnimationFrame(this.loop);
  }

  /* --------------------------------------------------------------- galerie */

  private buildGallery(): void {
    for (const category of EFFECT_CATEGORIES) {
      if (category.effects.length === 0) continue;
      const wrapper = document.createElement("section");
      wrapper.className = "fx-cat";
      wrapper.dataset.category = category.id;

      const title = document.createElement("h2");
      title.className = "fx-cat-title";
      const name = document.createElement("b");
      name.textContent = category.label;
      const count = document.createElement("span");
      count.textContent = String(category.effects.length);
      title.append(name, count);
      wrapper.append(title);

      const list = document.createElement("div");
      list.className = "fx-cat-list";

      for (const effect of category.effects) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "fx-card";
        card.dataset.family = effect.id;
        card.setAttribute("aria-pressed", "false");

        const thumb = document.createElement("canvas");
        thumb.width = 152;
        thumb.height = 86;
        thumb.setAttribute("aria-hidden", "true");

        const body = document.createElement("span");
        body.className = "fx-card-body";
        const label = document.createElement("b");
        label.className = "fx-card-name";
        label.textContent = effect.label;
        const id = document.createElement("small");
        id.className = "fx-card-id";
        id.textContent = effect.id;
        body.append(label, id);

        card.append(thumb, body);
        card.addEventListener("click", () => this.selectFamily(effect.id));
        list.append(card);

        this.cards.set(effect.id, card);
        this.previewQueue.push({ canvas: thumb, family: effect.id, index: this.previewQueue.length });
      }

      wrapper.append(list);
      this.gallery.append(wrapper);
      this.categories.set(category.id, wrapper);
    }

    el<HTMLElement>("fx-count").textContent = `${EFFECTS.length} effets`;
  }

  private schedulePreviews(): void {
    if (this.previewPumping) return;
    this.previewPumping = true;
    requestAnimationFrame(this.pumpPreviews);
  }

  private pumpPreviews = (): void => {
    const job = this.previewQueue.shift();
    if (job === undefined) {
      this.previewPumping = false;
      return;
    }
    this.renderPreview(job);
    requestAnimationFrame(this.pumpPreviews);
  };

  private renderPreview(job: { canvas: HTMLCanvasElement; family: FamilyId; index: number }): void {
    const ctx = job.canvas.getContext("2d");
    if (ctx === null) return;
    const look: EffectLook = {
      family: job.family,
      variant: job.family,
      role: "refrain",
      mood: "pulse",
      hue: (190 + job.index * 53) % 360,
      spread: 60,
      saturation: 0.82,
      lightness: 0.6,
    };
    applyEffectLook(this.previewTimeline, look);
    const time = (3 + job.index * 0.83) % this.previewTimeline.duration;
    try {
      renderFrame({
        ctx,
        width: job.canvas.width,
        height: job.canvas.height,
        dpr: 1,
        time,
        view: this.previewTimeline.view,
        plan: this.previewTimeline.plan,
        settings: { intensity: 1, flashes: 0.9, reduced: false },
        reducedMotion: false,
        quality: 0.55,
        frame: job.index,
      });
    } catch (error) {
      console.error("Aperçu impossible", job.family, error);
    }
  }

  private filterGallery(query: string): void {
    const needle = query.trim().toLowerCase();
    const empty = el<HTMLElement>("fx-empty");
    let visible = 0;
    for (const category of EFFECT_CATEGORIES) {
      const wrapper = this.categories.get(category.id);
      if (wrapper === undefined) continue;
      let categoryVisible = 0;
      for (const effect of category.effects) {
        const card = this.cards.get(effect.id);
        if (card === undefined) continue;
        const matches =
          needle.length === 0 ||
          effect.label.toLowerCase().includes(needle) ||
          effect.id.toLowerCase().includes(needle) ||
          category.label.toLowerCase().includes(needle);
        card.hidden = !matches;
        if (matches) categoryVisible += 1;
      }
      wrapper.hidden = categoryVisible === 0;
      visible += categoryVisible;
    }
    empty.hidden = visible !== 0;
  }

  /* --------------------------------------------------------------- réglages */

  private buildVariantOptions(): void {
    const select = el<HTMLSelectElement>("fx-variant");
    for (const effect of EFFECTS) {
      const option = document.createElement("option");
      option.value = effect.id;
      option.textContent = effect.label;
      select.append(option);
    }
  }

  private bindControls(): void {
    for (const spec of RANGES) {
      const input = el<HTMLInputElement>(spec.id);
      const out = el<HTMLOutputElement>(`${spec.id}-out`);
      input.value = String(this.state[spec.key]);
      out.textContent = spec.format(this.state[spec.key]);
      input.addEventListener("input", () => {
        this.state[spec.key] = Number(input.value);
        out.textContent = spec.format(this.state[spec.key]);
        this.changed();
      });
    }

    const impacts = el<HTMLInputElement>("fx-impacts");
    impacts.checked = this.state.impacts;
    impacts.addEventListener("change", () => {
      this.state.impacts = impacts.checked;
      this.changed();
    });

    const reduced = el<HTMLInputElement>("fx-reduced");
    reduced.checked = this.state.reduced;
    reduced.addEventListener("change", () => {
      this.state.reduced = reduced.checked;
      this.changed();
    });

    const haze = el<HTMLInputElement>("fx-haze");
    haze.checked = this.state.haze;
    haze.addEventListener("change", () => {
      this.state.haze = haze.checked;
      this.changed();
    });

    const seed = el<HTMLInputElement>("fx-seed");
    seed.value = String(this.state.seed);
    seed.addEventListener("input", () => {
      this.state.seed = clamp(Number(seed.value) || 0, 0, 99999);
      this.changed();
    });

    const variant = el<HTMLSelectElement>("fx-variant");
    variant.addEventListener("change", () => {
      this.state.variant = variant.value as FamilyId;
      this.changed();
    });

    const role = el<HTMLSelectElement>("fx-role");
    role.addEventListener("change", () => {
      this.state.role = role.value as SceneRole;
      this.changed();
    });

    const mood = el<HTMLSelectElement>("fx-mood");
    mood.addEventListener("change", () => {
      this.state.mood = mood.value as Mood;
      this.changed();
    });

    el<HTMLInputElement>("fx-search").addEventListener("input", (event) => {
      this.filterGallery((event.target as HTMLInputElement).value);
    });

    el<HTMLButtonElement>("fx-seed-random").addEventListener("click", () => {
      this.state.seed = Math.floor(Math.random() * 100000);
      seed.value = String(this.state.seed);
      this.changed();
    });
  }

  private bindActions(): void {
    el<HTMLButtonElement>("fx-play").addEventListener("click", () => this.togglePlay());
    el<HTMLButtonElement>("fx-reset").addEventListener("click", () => this.restart());
    el<HTMLButtonElement>("fx-random").addEventListener("click", () => this.randomize());
    el<HTMLButtonElement>("fx-fullscreen").addEventListener("click", () => void this.toggleFullscreen());
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        this.togglePlay();
      } else if (event.code === "ArrowRight" || event.code === "ArrowLeft") {
        event.preventDefault();
        const index = EFFECTS.findIndex((effect) => effect.id === this.state.family);
        const delta = event.code === "ArrowRight" ? 1 : -1;
        const next = EFFECTS[(index + delta + EFFECTS.length) % EFFECTS.length];
        if (next !== undefined) this.selectFamily(next.id);
      } else if (event.key.toLowerCase() === "r") {
        this.randomize();
      } else if (event.key.toLowerCase() === "f") {
        void this.toggleFullscreen();
      }
    });
  }

  private applyStateToDom(): void {
    for (const spec of RANGES) {
      const input = el<HTMLInputElement>(spec.id);
      input.value = String(this.state[spec.key]);
      el<HTMLOutputElement>(`${spec.id}-out`).textContent = spec.format(this.state[spec.key]);
    }
    el<HTMLInputElement>("fx-impacts").checked = this.state.impacts;
    el<HTMLInputElement>("fx-reduced").checked = this.state.reduced;
    el<HTMLInputElement>("fx-haze").checked = this.state.haze;
    el<HTMLInputElement>("fx-seed").value = String(this.state.seed);
    el<HTMLSelectElement>("fx-variant").value = this.state.variant;
    el<HTMLSelectElement>("fx-role").value = this.state.role;
    el<HTMLSelectElement>("fx-mood").value = this.state.mood;
  }

  private changed(): void {
    saveState(this.state);
    this.updateCurrentLabels();
  }

  private timelineParams(): EffectTimelineParams {
    return {
      tempo: this.state.tempo,
      energy: this.state.energy / 100,
      bass: this.state.bass / 100,
      high: this.state.high / 100,
      impacts: this.state.impacts,
      seed: this.state.seed,
    };
  }

  private ensureTimeline(): EffectTimeline {
    const params = this.timelineParams();
    const key = timelineKey(params);
    if (this.timeline === null || key !== this.builtKey) {
      this.timeline = buildEffectTimeline(params);
      this.builtKey = key;
    }
    applyEffectLook(this.timeline, {
      family: this.state.family,
      variant: this.state.variant,
      role: this.state.role,
      mood: this.state.mood,
      hue: this.state.hue,
      spread: this.state.spread,
      saturation: this.state.saturation / 100,
      lightness: this.state.lightness / 100,
    });
    return this.timeline;
  }

  private selectFamily(family: FamilyId, options: { reset?: boolean; silent?: boolean } = {}): void {
    const previous = this.state.family;
    this.state.family = family;
    if (this.state.variant === previous) {
      this.state.variant = family;
      el<HTMLSelectElement>("fx-variant").value = family;
    }
    if (options.reset === true) this.clock = 0;
    this.paused = false;
    this.updatePlayLabel();
    this.updateActiveCard();
    this.updateCurrentLabels();
    saveState(this.state);
    if (options.silent !== true) this.changed();
  }

  private updateActiveCard(): void {
    for (const [id, card] of this.cards) {
      const active = id === this.state.family;
      card.classList.toggle("is-active", active);
      card.setAttribute("aria-pressed", String(active));
    }
  }

  private currentEffect() {
    return EFFECTS.find((effect) => effect.id === this.state.family) ?? EFFECTS[0];
  }

  private updateCurrentLabels(): void {
    const effect = this.currentEffect();
    if (effect === undefined) return;
    el<HTMLElement>("fx-current-name").textContent = effect.label;
    el<HTMLElement>("fx-current-id").textContent = effect.id;
    el<HTMLElement>("fx-current-category").textContent = effect.categoryLabel;
    document.title = `Night Light — ${effect.label}`;
  }

  private togglePlay(): void {
    this.paused = !this.paused;
    this.updatePlayLabel();
  }

  private updatePlayLabel(): void {
    const button = el<HTMLButtonElement>("fx-play");
    button.setAttribute("aria-pressed", String(!this.paused));
    el<HTMLElement>("fx-play-icon").textContent = this.paused ? "▶" : "❚❚";
    el<HTMLElement>("fx-state").textContent = this.paused ? "en pause" : "en lecture";
  }

  private restart(): void {
    this.clock = 0;
    this.paused = false;
    this.updatePlayLabel();
  }

  private randomize(): void {
    const effect = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
    const variant = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
    if (effect === undefined || variant === undefined) return;

    this.state.family = effect.id;
    this.state.variant = variant.id;
    this.state.role = ROLES[Math.floor(Math.random() * ROLES.length)] ?? "refrain";
    this.state.mood = MOODS[Math.floor(Math.random() * MOODS.length)] ?? "pulse";
    this.state.hue = Math.round(Math.random() * 360);
    this.state.spread = 30 + Math.round(Math.random() * 120);
    this.state.saturation = 55 + Math.round(Math.random() * 45);
    this.state.lightness = 42 + Math.round(Math.random() * 32);
    this.state.seed = Math.floor(Math.random() * 100000);
    this.clock = 0;
    this.paused = false;
    this.applyStateToDom();
    this.updatePlayLabel();
    this.updateActiveCard();
    this.changed();
    this.toast(`Effet aléatoire : ${effect.label}`);
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement === null) {
        await this.stageWrap.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      this.toast("Le plein écran est refusé par ce navigateur.");
    }
  }

  private toast(text: string): void {
    const node = el<HTMLElement>("fx-toast");
    node.textContent = text;
    node.hidden = false;
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      node.hidden = true;
      this.toastTimer = null;
    }, 1900);
  }

  /* ----------------------------------------------------------------- rendu */

  private resize(): void {
    const width = Math.max(1, this.stageWrap.clientWidth);
    const height = Math.max(1, this.stageWrap.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width === pixelWidth && this.canvas.height === pixelHeight) return;
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
  }

  private hazeFor(quality: number, width: number, height: number): HazeTarget | undefined {
    if (this.haze === undefined) {
      const fine = preparerNappe(this.hazeCanvases.fine);
      const large = preparerNappe(this.hazeCanvases.large);
      if (fine === undefined || large === undefined) return undefined;
      this.haze = { fine, large };
    }
    dimensionnerNappe(this.haze.fine, quality >= 0.6 ? 0.5 : 0.4, width, height);
    dimensionnerNappe(this.haze.large, quality >= 0.9 ? 0.42 : quality >= 0.6 ? 0.36 : 0.3, width, height);
    return this.haze;
  }

  private settings(): RenderSettings {
    return {
      intensity: this.state.intensity / 100,
      flashes: this.state.flashes / 100,
      reduced: this.state.reduced,
    };
  }

  private loop = (timestamp: number): void => {
    requestAnimationFrame(this.loop);
    if (this.lastTs === 0) {
      this.lastTs = timestamp;
      return;
    }
    const delta = Math.min(0.1, (timestamp - this.lastTs) / 1000);
    this.lastTs = timestamp;
    if (delta > 0) {
      this.fps += (1 / delta - this.fps) * 0.05;
    }

    const timeline = this.ensureTimeline();
    if (!this.paused) {
      this.clock = (this.clock + delta * this.state.speed) % timeline.duration;
    }

    const quality = this.state.quality / 100;
    const width = Math.max(1, this.stageWrap.clientWidth);
    const height = Math.max(1, this.stageWrap.clientHeight);
    const haze = this.state.haze ? this.hazeFor(quality, width, height) : undefined;

    try {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderFrame({
        ctx: this.ctx,
        width,
        height,
        dpr: this.canvas.width / width,
        time: this.clock,
        view: timeline.view,
        plan: timeline.plan,
        settings: this.settings(),
        reducedMotion: this.reducedMotion,
        quality,
        frame: this.frame,
        haze,
      });
      this.frame += 1;
    } catch (error) {
      this.paused = true;
      this.updatePlayLabel();
      this.toast("Le rendu de cet effet a échoué.");
      console.error("Rendu interrompu", error);
    }

    this.updateHud(timestamp);
  };

  private updateHud(timestamp: number): void {
    if (timestamp - this.lastHud < 250) return;
    this.lastHud = timestamp;
    el<HTMLElement>("fx-fps").textContent = `${this.fps.toFixed(0)} fps`;
    const seconds = Math.floor(this.clock % EFFECT_DURATION_SEC);
    const minutes = Math.floor(seconds / 60);
    el<HTMLElement>("fx-clock").textContent = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }
}

function boot(): void {
  try {
    new Studio();
  } catch (error) {
    console.error("Impossible de démarrer le studio d'effets", error);
    const name = document.getElementById("fx-current-name");
    if (name !== null) name.textContent = "Studio indisponible dans ce navigateur";
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
