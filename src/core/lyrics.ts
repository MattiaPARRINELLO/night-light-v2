import type { KeywordCue, LyricLine, LyricsCues } from "../types";
import { clamp01 } from "./series";
import type { Palette } from "./show";

const FONT_STACK = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Délai après lequel un mot marquant s'efface, en millisecondes. */
const CUE_TAIL_MS = 420;
const CUE_FADE_IN_MS = 90;
const CUE_FADE_OUT_MS = 260;

export interface LyricsDrawOptions {
  palette: Palette;
  reduced: boolean;
  /** Intensité du temps fort courant, 0..1, pour le pulsage du mot. */
  beat: number;
}

/**
 * Dessine les paroles par-dessus la scène : des mots seuls, en très gros.
 *
 * Un mot marquant s'affiche où qu'il soit ; sinon, seul un refrain montre le
 * mot en cours. Hors de ces deux cas, rien n'est dessiné et la lumière respire.
 * Fonction pure du temps musical, sans état accumulé, donc identique après une
 * pause ou un retour en arrière.
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

  const chorus =
    lyrics.chorusLines.includes(index) || (lyrics.shoutLines ?? []).includes(index);
  const cue = activeCue(lyrics.keywords, index, ms);
  // Refrain : la phrase entière. Ailleurs : un mot marquant, ou rien du tout.
  if (!chorus && cue === null) return;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (chorus) {
    drawChorusLine(ctx, line, ms, width, height, options);
  } else if (cue !== null) {
    drawBigWord(ctx, cue, ms, width, height, options);
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

function drawBigWord(
  ctx: CanvasRenderingContext2D,
  cue: KeywordCue,
  ms: number,
  width: number,
  height: number,
  options: LyricsDrawOptions,
): void {
  const word = cue.text.trim();
  if (word.length === 0) return;
  const duration = Math.max(1, cue.endMs - cue.startMs);
  const alpha = envelope(
    ms,
    cue.startMs,
    cue.endMs + CUE_TAIL_MS,
    Math.min(CUE_FADE_IN_MS, duration * 0.35),
    Math.min(CUE_FADE_OUT_MS, duration * 0.45),
  );
  if (alpha <= 0.01) return;

  const text = word.toUpperCase();
  const isTitle = cue.kind === "titre";
  const maxWidth = width * 0.88;
  let size = Math.min(width * 0.17, height * 0.26) * (isTitle ? 1.08 : 1);
  ctx.font = `800 ${size}px ${FONT_STACK}`;
  const measured = ctx.measureText(text).width;
  if (measured > maxWidth) {
    size = Math.max(18, size * (maxWidth / measured));
    ctx.font = `800 ${size}px ${FONT_STACK}`;
  }

  const age = Math.max(0, ms - cue.startMs) / 1000;
  const attack = options.reduced ? 0 : 1 - clamp01(age / 0.18);
  const pulse = options.reduced ? 0 : 0.04 * options.beat;
  const scale = 0.94 + 0.06 * (1 - attack) + pulse;
  const y = height * (0.46 - 0.02 * cue.impact);

  ctx.globalAlpha = alpha;
  ctx.translate(width * 0.5, y);
  ctx.scale(scale, scale);
  // Le titre se distingue par sa couleur d'accent, pas par sa taille : c'est
  // une signature, pas un mot marquant de plus.
  ctx.fillStyle = isTitle ? accentSolid(options.palette) : "#ffffff";
  ctx.shadowColor = accentColor(options.palette, 0.85);
  const blurCeiling = isTitle ? 64 : 52;
  ctx.shadowBlur = options.reduced ? 0 : Math.min(size * (0.28 + 0.3 * cue.impact), blurCeiling);
  ctx.fillText(text, 0, 0);
}

/**
 * Refrain : la phrase entière, en grand, sur une à trois lignes.
 *
 * Le mot en cours est mis en couleur d'accent, les mots déjà chantés sont
 * atténués. Une phrase longue rétrécit jusqu'à tenir, plutôt que d'être coupée.
 */
function drawChorusLine(
  ctx: CanvasRenderingContext2D,
  line: LyricLine,
  ms: number,
  width: number,
  height: number,
  options: LyricsDrawOptions,
): void {
  const duration = Math.max(1, line.endMs - line.startMs);
  const alpha = envelope(
    ms,
    line.startMs,
    line.endMs,
    Math.min(140, duration * 0.12),
    Math.min(280, duration * 0.18),
  );
  if (alpha <= 0.01) return;

  const timed = line.words.length > 0;
  const tokens = timed
    ? line.words
    : line.text
        .split(/\s+/)
        .filter((word) => word.length > 0)
        .map((word) => ({ text: word, startMs: 0, endMs: 0 }));
  const maxWidth = width * 0.9;
  let size = Math.min(width * 0.105, height * 0.16);
  let rows: number[][] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    ctx.font = `800 ${size}px ${FONT_STACK}`;
    rows = wrapTokens(ctx, tokens, maxWidth);
    if (rows.length <= 3) break;
    size *= 0.86;
  }
  if (size < 14) size = 14;
  ctx.font = `800 ${size}px ${FONT_STACK}`;

  const lineHeight = size * 1.08;
  const totalHeight = rows.length * lineHeight;
  const startY = height * 0.46 - totalHeight * 0.5 + lineHeight * 0.5;

  const age = Math.max(0, ms - line.startMs) / 1000;
  const attack = options.reduced ? 0 : 1 - clamp01(age / 0.22);
  const pulse = options.reduced ? 0 : 0.03 * options.beat;
  const scale = 0.96 + 0.04 * (1 - attack) + pulse;

  ctx.globalAlpha = alpha;
  ctx.translate(width * 0.5, height * 0.46);
  ctx.scale(scale, scale);
  ctx.translate(-width * 0.5, -height * 0.46);
  ctx.shadowColor = accentColor(options.palette, 0.65);
  ctx.shadowBlur = options.reduced ? 0 : Math.min(size * 0.28, 40);

  rows.forEach((row, rowIndex) => {
    const texts = row.map((tokenIndex) => tokens[tokenIndex]!.text.trim().toUpperCase());
    const rowWidth = texts.reduce((sum, text) => sum + ctx.measureText(`${text} `).width, 0) - ctx.measureText(" ").width;
    let x = width * 0.5 - rowWidth * 0.5;
    const y = startY + rowIndex * lineHeight;
    row.forEach((tokenIndex, position) => {
      const token = tokens[tokenIndex]!;
      const text = texts[position]!;
      const current = timed && token.startMs <= ms && ms < token.endMs;
      const past = timed && ms >= token.endMs;
      ctx.fillStyle = !timed
        ? "rgba(255,255,255,0.92)"
        : current
          ? accentSolid(options.palette)
          : past
            ? "rgba(255,255,255,0.55)"
            : "rgba(255,255,255,0.92)";
      ctx.textAlign = "left";
      ctx.fillText(text, x, y);
      x += ctx.measureText(`${text} `).width;
    });
  });
}

/** Répartit les mots en lignes sans dépasser `maxWidth`. */
function wrapTokens(
  ctx: CanvasRenderingContext2D,
  tokens: LyricLine["words"],
  maxWidth: number,
): number[][] {
  const rows: number[][] = [];
  let row: number[] = [];
  let rowWidth = 0;
  const space = ctx.measureText(" ").width;
  tokens.forEach((token, index) => {
    const text = token.text.trim().toUpperCase();
    const width = ctx.measureText(text).width;
    if (row.length > 0 && rowWidth + space + width > maxWidth) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    row.push(index);
    rowWidth += (row.length > 1 ? space : 0) + width;
  });
  if (row.length > 0) rows.push(row);
  return rows;
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

function accentSolid(palette: Palette): string {
  const hue = palette.accent;
  const saturation = Math.round(clamp01(palette.saturation) * 100);
  return `hsl(${hue.toFixed(1)}, ${saturation}%, 78%)`;
}
