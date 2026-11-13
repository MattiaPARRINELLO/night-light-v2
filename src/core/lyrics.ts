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

  const chorus = lyrics.chorusLines.includes(index);
  const cue = activeCue(lyrics.keywords, index, ms);
  // Aucun mot à l'écran hors refrain : seuls les mots marquants prennent la
  // scène, sinon la lumière respire seule.
  if (cue === null && !chorus) return;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawBigWord(ctx, line, cue, ms, width, height, options);
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
  line: LyricLine,
  cue: KeywordCue | null,
  ms: number,
  width: number,
  height: number,
  options: LyricsDrawOptions,
): void {
  const fallback = cue === null ? contentWordAt(line, ms) : null;
  const word = cue?.text ?? fallback?.text ?? null;
  if (word === null || word.trim().length === 0) return;
  const start = cue?.startMs ?? fallback?.startMs ?? line.startMs;
  const end = cue?.endMs ?? fallback?.endMs ?? line.endMs;
  const duration = Math.max(1, end - start);
  // Les mots courts durent parfois 100 ms : un fondu fixe les rendrait gris.
  const alpha = envelope(
    ms,
    start,
    end + (cue === null ? 0 : CUE_TAIL_MS),
    Math.min(CUE_FADE_IN_MS, duration * 0.35),
    Math.min(CUE_FADE_OUT_MS, duration * 0.45),
  );
  if (alpha <= 0.01) return;

  const text = word.trim().toUpperCase();
  const isTitle = cue?.kind === "titre";
  const maxWidth = width * 0.88;
  let size = Math.min(width * 0.17, height * 0.26) * (isTitle ? 1.08 : 1);
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
  // Le titre se distingue par sa couleur d'accent, pas par sa taille : c'est
  // une signature, pas un mot marquant de plus.
  ctx.fillStyle = isTitle ? accentSolid(options.palette) : "#ffffff";
  ctx.shadowColor = accentColor(options.palette, 0.85);
  const blurCeiling = isTitle ? 64 : 52;
  ctx.shadowBlur = options.reduced ? 0 : Math.min(size * (0.28 + 0.3 * impact), blurCeiling);
  ctx.fillText(text, 0, 0);
}

/** Mots grammaticaux : jamais mis en gros, ils n'ont aucun impact visuel. */
const STOPWORDS = new Set([
  "alors", "avec", "aussi", "autre", "avant", "avoir", "bien", "cette", "comme", "comment",
  "dans", "depuis", "deux", "donc", "elle", "encore", "entre", "etre", "faire", "faut",
  "elle", "ils", "leur", "mais", "meme", "moins", "monde", "nous", "notre", "parce",
  "pendant", "petit", "peut", "plus", "pour", "pourquoi", "presque", "quand", "rien",
  "sans", "seulement", "sont", "sous", "souvent", "temps", "toujours", "toute", "tous",
  "trop", "venir", "vers", "vouloir", "vraiment", "vous", "avec", "cest", "jai", "jai",
]);

function cleanWord(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-zà-öø-ÿ0-9']/g, "");
}

/**
 * Dernier mot porteur de sens déjà chanté dans la ligne.
 *
 * Sans lui, un refrain afficherait « VA » ou « NE » en pleine largeur : court,
 * grammatical, sans impact. Le mot précédent reste affiché jusqu'au suivant,
 * donc l'écran n'est jamais vide au milieu d'une phrase.
 */
function contentWordAt(line: LyricLine, ms: number): { text: string; startMs: number; endMs: number } | null {
  let best: { text: string; startMs: number; endMs: number } | null = null;
  for (const word of line.words) {
    if (word.startMs > ms) break;
    const clean = cleanWord(word.text);
    if (clean.length < 3 || STOPWORDS.has(clean)) continue;
    best = word;
  }
  return best;
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
