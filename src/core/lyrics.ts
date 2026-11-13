import type { KeywordCue, LyricLine, LyricsCues } from "../types";
import { clamp01 } from "./series";
import type { Palette } from "./show";

const FONT_STACK = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Délai après lequel un mot marquant s'efface, en millisecondes. */
const CUE_TAIL_MS = 420;
const CUE_FADE_IN_MS = 90;
const CUE_FADE_OUT_MS = 260;
const LINE_FADE_IN_MS = 120;
const LINE_FADE_OUT_MS = 220;

export interface LyricsDrawOptions {
  palette: Palette;
  reduced: boolean;
  /** Intensité du temps fort courant, 0..1, pour le pulsage du mot. */
  beat: number;
}

/**
 * Dessine les paroles par-dessus la scène.
 *
 * Refrain : un mot seul, très gros, centré. Couplet : la ligne en bas, mot
 * courant surligné. Fonction pure du temps musical, sans état accumulé, donc
 * identique après une pause ou un retour en arrière.
 */
export function drawLyrics(
  ctx: CanvasRenderingContext2D,
  lyrics: LyricsCues,
  timeSec: number,
  width: number,
  height: number,
  options: LyricsDrawOptions,
): void {
  if (lyrics.lines.length === 0) return;
  const ms = timeSec * 1000;
  const index = lineIndexAt(lyrics.lines, ms);
  if (index < 0) return;
  const line = lyrics.lines[index];
  if (line === undefined || !line.text.trim()) return;

  const chorus = lyrics.chorusLines.includes(index);
  const cue = activeCue(lyrics.keywords, index, ms);

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (chorus) {
    drawChorusWord(ctx, line, cue, ms, width, height, options);
  } else {
    drawVerseLine(ctx, line, ms, width, height, options);
  }
  ctx.restore();
}

function lineIndexAt(lines: LyricLine[], ms: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const line = lines[middle];
    if (line === undefined) break;
    if (line.startMs <= ms) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function activeCue(cues: KeywordCue[], index: number, ms: number): KeywordCue | null {
  let best: KeywordCue | null = null;
  for (const cue of cues) {
    if (Math.abs(cue.lineIndex - index) > 1) continue;
    const visible = cue.startMs - 220 <= ms && ms <= cue.endMs + CUE_TAIL_MS;
    if (!visible) continue;
    if (best === null || cue.startMs > best.startMs) best = cue;
  }
  return best;
}

function drawChorusWord(
  ctx: CanvasRenderingContext2D,
  line: LyricLine,
  cue: KeywordCue | null,
  ms: number,
  width: number,
  height: number,
  options: LyricsDrawOptions,
): void {
  const word = cue?.text ?? currentWordText(line, ms);
  if (word === null || word.trim().length === 0) return;
  const start = cue?.startMs ?? currentWordStart(line, ms) ?? line.startMs;
  const end = cue?.endMs ?? currentWordEnd(line, ms) ?? line.endMs;
  const alpha = envelope(ms, start, end + (cue === null ? 0 : CUE_TAIL_MS), CUE_FADE_IN_MS, CUE_FADE_OUT_MS);
  if (alpha <= 0.01) return;

  const text = word.trim().toUpperCase();
  const maxWidth = width * 0.88;
  let size = Math.min(width * 0.17, height * 0.26);
  ctx.font = `800 ${size}px ${FONT_STACK}`;
  const measured = ctx.measureText(text).width;
  if (measured > maxWidth) {
    size = Math.max(18, size * (maxWidth / measured));
    ctx.font = `800 ${size}px ${FONT_STACK}`;
  }

  const age = Math.max(0, ms - start) / 1000;
  const attack = options.reduced ? 0 : 1 - clamp01(age / 0.18);
  const pulse = options.reduced ? 0 : 0.04 * options.beat;
  const scale = 0.94 + 0.06 * (1 - attack) + pulse;
  const impact = cue?.impact ?? 0.6;
  const y = height * (0.46 - 0.02 * impact);

  ctx.globalAlpha = alpha;
  ctx.translate(width * 0.5, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = accentColor(options.palette, 0.85);
  ctx.shadowBlur = options.reduced ? 0 : Math.min(size * (0.28 + 0.3 * impact), 52);
  ctx.fillText(text, 0, 0);
}

function drawVerseLine(
  ctx: CanvasRenderingContext2D,
  line: LyricLine,
  ms: number,
  width: number,
  height: number,
  options: LyricsDrawOptions,
): void {
  const alpha = envelope(ms, line.startMs, line.endMs, LINE_FADE_IN_MS, LINE_FADE_OUT_MS);
  if (alpha <= 0.01) return;

  const words = line.words.length > 0 ? line.words : [{ text: line.text, startMs: line.startMs, endMs: line.endMs }];
  const maxWidth = width * 0.9;
  let size = Math.min(Math.max(width * 0.034, 16), 38);
  const fullWidth = () => {
    ctx.font = `600 ${size}px ${FONT_STACK}`;
    return words.reduce((total, word) => total + ctx.measureText(word.text).width, 0);
  };
  let measured = fullWidth();
  if (measured > maxWidth) {
    size = Math.max(12, size * (maxWidth / measured));
    measured = fullWidth();
  }

  const x0 = width * 0.5 - measured * 0.5;
  const y = height * 0.88;
  ctx.globalAlpha = alpha * 0.78;
  ctx.textAlign = "left";
  ctx.font = `600 ${size}px ${FONT_STACK}`;

  let x = x0;
  for (const word of words) {
    const isCurrent = word.startMs <= ms && ms < word.endMs;
    const isPast = ms >= word.endMs;
    ctx.fillStyle = isCurrent ? "#ffffff" : isPast ? "rgba(255,255,255,0.42)" : "rgba(255,255,255,0.68)";
    if (isCurrent) {
      ctx.shadowColor = accentColor(options.palette, 1);
      ctx.shadowBlur = options.reduced ? 0 : size * 0.55;
    } else {
      ctx.shadowBlur = 0;
    }
    ctx.fillText(word.text, x, y);
    x += ctx.measureText(word.text).width;
  }
  ctx.shadowBlur = 0;
}

function currentWordText(line: LyricLine, ms: number): string | null {
  const word = line.words.find((candidate) => candidate.startMs <= ms && ms < candidate.endMs);
  return word?.text ?? line.words[line.words.length - 1]?.text ?? null;
}

function currentWordStart(line: LyricLine, ms: number): number | null {
  const word = line.words.find((candidate) => candidate.startMs <= ms && ms < candidate.endMs);
  return word?.startMs ?? null;
}

function currentWordEnd(line: LyricLine, ms: number): number | null {
  const word = line.words.find((candidate) => candidate.startMs <= ms && ms < candidate.endMs);
  return word?.endMs ?? null;
}

/** Enveloppe d'apparition : montée courte, sortie douce, nulle hors fenêtre. */
function envelope(ms: number, start: number, end: number, fadeIn: number, fadeOut: number): number {
  if (ms < start || ms > end) return 0;
  const rise = fadeIn > 0 ? clamp01((ms - start) / fadeIn) : 1;
  const fall = fadeOut > 0 ? clamp01((end - ms) / fadeOut) : 1;
  return Math.min(rise, fall);
}

function accentColor(palette: Palette, alpha: number): string {
  const hue = palette.accent;
  const saturation = Math.round(clamp01(palette.saturation) * 100);
  return `hsla(${hue.toFixed(1)}, ${saturation}%, 62%, ${alpha.toFixed(3)})`;
}
