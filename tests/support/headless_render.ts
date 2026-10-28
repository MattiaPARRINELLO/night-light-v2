/**
 * Rendu headless réel : Chromium + vrai canvas 2D.
 *
 * Le rendu de production est bundlé par Bun (`target: browser`) puis chargé
 * dans une page vide. Aucune dépendance à l'application web, aucun réseau :
 * seuls `renderFrame`, `TrackView` et `buildShowPlan` sont utilisés.
 *
 * L'API est volontairement séquentielle (une page, un contexte) : les mesures
 * doivent être reproductibles, pas parallèles.
 */

import { build } from "bun";
import { chromium, type Browser, type Page } from "playwright";

import type { RenderSettings } from "../../src/types";
import type { HeadlessApi } from "./headless_browser";

export interface RenderSetup {
  /** Analyse du morceau (JSON du serveur). */
  analysis: unknown;
  /** Rendu d'un plan réduit. */
  reduced?: boolean;
  width: number;
  height: number;
  dpr: number;
  quality: number;
  settings: RenderSettings;
  reducedMotion: boolean;
}

export interface CompareRequest extends RenderSetup {
  time: number;
  fps: number;
  /** Chauffe chaque canvas une fois avant la mesure (voir headless_browser). */
  warmup?: boolean;
}

export interface CompareResult {
  time: number;
  diffPixels: number;
  maxDelta: number;
  totalPixels: number;
  hashContinuous: string;
  hashSeek: string;
  whiteRatioContinuous: number;
  whiteRatioSeek: number;
  scenes: number;
  diffBBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  diffSamples: Array<{ x: number; y: number; before: number[]; after: number[] }>;
}

export interface ImageStats {
  hash: string;
  whiteRatio: number;
  total: number;
  white: number;
}

export interface CaptureResult {
  png: string;
  width: number;
  height: number;
  luminanceMean: number;
  whiteRatio: number;
  centerEdgeRatio: number;
  dominantHues: number;
  hueBuckets: Array<{ hue: number; share: number }>;
  /** Saturation HSV moyenne des pixels éclairés (luminance ≥ 0,05). */
  saturationMean?: number;
  /** Teinte moyenne circulaire, pondérée par saturation × luminance. */
  hueMean?: number;
  /** Teinte moyenne des pixels franchement colorés (saturation ≥ 0,45). */
  hueSaturated?: number;
}

export interface HeadlessRenderer {
  /** Prépare le canvas et le plan pour des mesures successives. */
  setup(payload: RenderSetup): Promise<{ scenes: number; width: number; height: number }>;
  /** Rend une image sur le canvas courant (diagnostic). */
  renderAt(time: number, frame?: number): Promise<void>;
  /** Efface le canvas courant (diagnostic de dépendance à l'historique). */
  clear(): Promise<void>;
  /** Part de pixels proches du blanc pour une série d'instants (un seul aller-retour). */
  whiteRatios(times: ReadonlyArray<number>, fps?: number): Promise<number[]>;
  /** Empreinte + part de blanc d'une image. */
  imageStats(time: number, frame?: number): Promise<ImageStats>;
  /** PNG + mesures d'éclairage d'une image (captures de référence). */
  capture(time: number, frame?: number): Promise<CaptureResult>;
  /** Boucle de rendu in-page (mesure de coût par image). */
  renderLoop(count: number, fps?: number, start?: number): Promise<{
    scenes: number;
    elapsedMs: number;
    perFrameMs: number;
  }>;
  /** Compare rendu continu puis seek, sur deux canvas distincts. */
  compareContinuousSeek(payload: CompareRequest): Promise<CompareResult>;
  close(): Promise<void>;
}

let bundlePromise: Promise<string> | null = null;

async function bundleRenderer(): Promise<string> {
  if (bundlePromise === null) {
    bundlePromise = (async () => {
      const config = {
        entrypoints: [`${import.meta.dir}/headless_browser.ts`],
        target: "browser",
        format: "iife",
        write: false,
      } as Parameters<typeof build>[0];
      const result = await build(config);
      if (!result.success) {
        throw new Error(`bundle headless en échec : ${result.logs.map(String).join("\n")}`);
      }
      const output = result.outputs[0];
      if (output === undefined) throw new Error("bundle headless vide");
      return await output.text();
    })();
  }
  return bundlePromise;
}

async function openPage(browser: Browser, script: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => {
    return (globalThis as unknown as { __nightlight?: unknown }).__nightlight !== undefined;
  });
  return page;
}

export async function createHeadlessRenderer(): Promise<HeadlessRenderer> {
  const script = await bundleRenderer();
  // Rastérisation logicielle : les mesures ne doivent pas dépendre du GPU de la
  // machine. Le résidu de premier rendu mesuré est identique avec ou sans GPU.
  const extraArgs = (process.env.NIGHTLIGHT_HEADLESS_ARGS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-accelerated-2d-canvas", "--disable-gpu", ...extraArgs],
  });
  const page = await openPage(browser, script);

  const invoke = <T>(name: keyof HeadlessApi, arg: unknown): Promise<T> =>
    page.evaluate(
      (request: { name: string; arg: unknown }) => {
        const api = (globalThis as unknown as { __nightlight: Record<string, (value: unknown) => unknown> })
          .__nightlight;
        const fn = api[request.name];
        if (fn === undefined) throw new Error(`méthode headless absente : ${request.name}`);
        return fn(request.arg);
      },
      { name, arg },
    ) as Promise<T>;

  return {
    async setup(payload) {
      return invoke("setup", payload);
    },
    async renderAt(time, frame = Math.round(time * 10)) {
      await invoke("renderAt", { time, frame });
    },
    async clear() {
      await invoke("clear", {});
    },
    async whiteRatios(times, fps = 10) {
      return invoke("whiteRatios", { times: [...times], fps });
    },
    async imageStats(time, frame = Math.round(time * 10)) {
      return invoke("imageStats", { time, frame });
    },
    async capture(time, frame = Math.round(time * 10)) {
      return invoke("capture", { time, frame });
    },
    async renderLoop(count, fps = 60, start = 0) {
      return invoke("renderLoop", { count, fps, start });
    },
    async compareContinuousSeek(payload) {
      return invoke("compareContinuousSeek", payload);
    },
    async close() {
      await browser.close();
    },
  };
}
