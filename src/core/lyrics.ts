import type { KeywordCue, LyricLine, LyricsCues, LyricWord, Section } from "../types";
import { clamp01 } from "./series";
import type { Palette } from "./show";

const FONT_STACK = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Délai après lequel un mot marquant s'efface, en millisecondes. */
const CUE_TAIL_MS = 420;
const CUE_FADE_IN_MS = 90;
const CUE_FADE_OUT_MS = 260;

/**
 * Écart maximal entre deux lignes de refrain pour n'en faire qu'un bloc, en
 * secondes. Même valeur que le serveur : une respiration courte entre deux
 * lignes ne doit pas rallumer puis rééteindre la salle.
 */
const CHORUS_MERGE_GAP_SEC = 2.5;
/** Montée de la lumière de salle à l'entrée d'un refrain, en secondes. */
const CHORUS_FADE_IN_SEC = 0.35;
/** Extinction à la sortie du refrain, en secondes. */
const CHORUS_FADE_OUT_SEC = 0.55;
/** Taille relative d'un adlib entre parenthèses, par rapport à la phrase. */
const ADLIB_SCALE = 0.62;

/** Plages de refrain fusionnées, mémorisées par jeu de paroles. */
const chorusRangeCache = new WeakMap<LyricsCues, Array<[number, number]>>();

export interface LyricsDrawOptions {
  palette: Palette;
  reduced: boolean;
  /** Intensité du temps fort courant, 0..1, pour le pulsage du mot. */
  beat: number;
}

/**
 * Dessine les paroles par-dessus la scène : des mots seuls, en très gros.
 *
 * Une ligne se dit mot à mot ; un refrain ou une phrase criée s'affiche d'un
 * bloc. Le motif répété d'une ligne prend la scène à chacune de ses occurrences,
 * jamais avant. Entre deux lignes, rien n'est dessiné et la lumière respire.
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
  const shout = (lyrics.shoutLines ?? []).includes(index);
  const cue = activeCue(lyrics.keywords, index, ms);
  const tokens = withTimings(line);
  const current = currentToken(tokens, ms);
  const repeat = repeatedWord(tokens);
  // Le motif ne prend la scène qu'au moment où il est chanté : hors de ses
  // occurrences, la phrase continue de se dire mot à mot.
  const occurrence = repeat !== null && current !== null ? occurrenceOf(repeat, current) : null;
  const adlibFlags = adlibTokenFlags(line, tokens);
  const currentIndex = current === null ? -1 : tokens.indexOf(current);
  const currentAdlib = currentIndex >= 0 && adlibFlags[currentIndex] === true;
  if (!line.text.trim()) return;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (isAdlibLine(line.text)) {
    // Ligne entièrement entre parenthèses : un adlib. Il se montre en petit,
    // comme un souffle derrière la voix, jamais comme la parole principale.
    drawPhrase(ctx, line, ms, width, height, options, 0.55, true);
  } else if (repeat !== null && occurrence !== null && !currentAdlib) {
    drawRepeatedWord(ctx, repeat, occurrence, ms, width, height, options);
  } else if (chorus) {
    // Refrain : la phrase entière, la plus grande de toutes.
    drawPhrase(ctx, line, ms, width, height, options, 1);
  } else if (shout) {
    // Phrase criée : entière aussi, un cran en dessous du refrain.
    drawPhrase(ctx, line, ms, width, height, options, 0.78);
  } else {
    // Tout le reste : mot à mot, taille courante, mis en avant s'il est marquant.
    drawLineWord(ctx, ms, width, height, options, cue !== null, current, currentAdlib);
  }
  ctx.restore();
}

/**
 * Plages de caractères occupées par un adlib, entre parenthèses ou crochets.
 *
 * Un adlib double la voix ou la ponctue : il ne fait pas partie de la parole
 * chantée. On ne l'utilise donc jamais pour repérer un refrain, et on l'affiche
 * plus petit que le reste.
 */
function adlibRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const pattern = /[([{][^)\]}]*[)\]}]/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const start = match.index;
    ranges.push([start, start + match[0].length]);
    match = pattern.exec(text);
  }
  return ranges;
}

/** Ligne entièrement entre parenthèses : un adlib, pas une parole. */
function isAdlibLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  const ranges = adlibRanges(trimmed);
  return ranges.length === 1 && ranges[0]![0] === 0 && ranges[0]![1] === trimmed.length;
}

/** Adlib par mot, d'après la position du mot dans le texte de la ligne. */
function adlibTokenFlags(line: LyricLine, tokens: LyricWord[]): boolean[] {
  const ranges = adlibRanges(line.text);
  if (ranges.length === 0) return tokens.map(() => false);
  let cursor = 0;
  return tokens.map((token) => {
    let offset: number;
    if (line.words.length > 0) {
      offset = cursor;
      cursor += token.text.length;
    } else {
      const found = line.text.indexOf(token.text, cursor);
      offset = found < 0 ? cursor : found;
      cursor = offset + token.text.length;
    }
    return ranges.some(([start, end]) => offset >= start && offset < end);
  });
}

/**
 * Présence du refrain à un instant donné, 0..1, d'après les paroles.
 *
 * Les lignes marquées `chorusLines` sont fusionnées en blocs (une respiration
 * courte entre deux lignes ne coupe pas le refrain), puis la valeur monte et
 * retombe doucement sur les bords du bloc. Sert à éclairer la salle en mode
 * concert : le rendu y ajoute une lumière d'ambiance, sans changer la couleur
 * du morceau ni les projecteurs.
 *
 * Quand l'analyse fournit des sections de refrain, un bloc est prolongé
 * jusqu'à la fin de la section qui le contient : le refrain chanté n'est
 * souvent que les premières lignes d'une section plus longue, et couper la
 * lumière à la dernière ligne éteint la salle au milieu du refrain.
 */
export function chorusIntensityAt(
  lyrics: LyricsCues | undefined,
  timeSec: number,
  sections?: readonly Section[],
): number {
  if (lyrics === undefined || lyrics.chorusLines.length === 0) return 0;
  const ranges = chorusRangesUntilSectionEnd(lyrics, sections);
  for (const [start, end] of ranges) {
    if (timeSec < start || timeSec > end) continue;
    const rise = clamp01((timeSec - start) / CHORUS_FADE_IN_SEC);
    const fall = clamp01((end - timeSec) / CHORUS_FADE_OUT_SEC);
    return Math.min(rise, fall);
  }
  return 0;
}

/** Blocs de refrain, en secondes, fusionnés quand deux lignes se suivent. */
function chorusRanges(lyrics: LyricsCues): Array<[number, number]> {
  const cached = chorusRangeCache.get(lyrics);
  if (cached !== undefined) return cached;
  const wanted = new Set(lyrics.chorusLines);
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < lyrics.lines.length; index += 1) {
    if (!wanted.has(index)) continue;
    const line = lyrics.lines[index];
    if (line === undefined) continue;
    const start = line.startMs / 1000;
    const end = line.endMs / 1000;
    if (!(end > start)) continue;
    const previous = ranges[ranges.length - 1];
    if (previous !== undefined && start - previous[1] <= CHORUS_MERGE_GAP_SEC) {
      previous[1] = Math.max(previous[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  chorusRangeCache.set(lyrics, ranges);
  return ranges;
}

/**
 * Blocs de refrain prolongés jusqu'à la fin de la section qui les contient.
 *
 * Les paroles ne marquent souvent que les deux premières phrases du refrain :
 * la section musicale, elle, va jusqu'au bout. On garde donc l'ancre des
 * paroles (aucune lumière sans refrain chanté) et on étend seulement la fin.
 * Un bloc qui ne tombe dans aucune section de refrain reste inchangé.
 */
function chorusRangesUntilSectionEnd(
  lyrics: LyricsCues,
  sections: readonly Section[] | undefined,
): Array<[number, number]> {
  const ranges = chorusRanges(lyrics);
  if (sections === undefined || sections.length === 0) return ranges;
  const extended: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const middle = (start + end) / 2;
    let stop = end;
    for (const section of sections) {
      if (section.kind !== "refrain") continue;
      if (middle < section.start || middle > section.end) continue;
      stop = Math.max(stop, section.end);
    }
    const previous = extended[extended.length - 1];
    if (previous !== undefined && start - previous[1] <= CHORUS_MERGE_GAP_SEC) {
      previous[1] = Math.max(previous[1], stop);
    } else {
      extended.push([start, stop]);
    }
  }
  return extended;
}

/** Dernier mot dont le chant a commencé, celui qui occupe la scène. */
function currentToken(tokens: LyricWord[], ms: number): LyricWord | null {
  let current: LyricWord | null = null;
  for (const token of tokens) {
    if (token.startMs > ms) break;
    current = token;
  }
  return current;
}

/** Occurrence du motif correspondant au mot en cours, s'il en fait partie. */
function occurrenceOf(
  repeat: RepeatedWord,
  token: LyricWord,
): { startMs: number; endMs: number } | null {
  for (const occurrence of repeat.occurrences) {
    if (occurrence.startMs === token.startMs) return occurrence;
  }
  return null;
}

interface RepeatedWord {
  /** Texte affiché, sans ponctuation. */
  text: string;
  occurrences: { startMs: number; endMs: number }[];
  /** Mots qui changent entre deux occurrences (« x », « y », « z »). */
  others: { text: string; startMs: number; endMs: number }[];
}

/**
 * Mot répété dans la phrase, s'il y en a un.
 *
 * « nique x, nique y, nique z » comme « nique, nique, nique » : le mot qui
 * revient est le motif de la ligne. Les mots variables sont conservés à part,
 * pour être montrés plus petits au moment où ils sont chantés.
 */
function repeatedWord(tokens: LyricWord[]): RepeatedWord | null {
  if (tokens.length < 2) return null;
  const groups = new Map<string, { text: string; occurrences: { startMs: number; endMs: number }[] }>();
  for (const token of tokens) {
    const key = normalizeWord(token.text);
    if (key.length < 3) continue;
    const entry = groups.get(key) ?? { text: token.text.trim(), occurrences: [] };
    entry.occurrences.push({ startMs: token.startMs, endMs: token.endMs });
    groups.set(key, entry);
  }
  let bestKey: string | null = null;
  let best = null as { text: string; occurrences: { startMs: number; endMs: number }[] } | null;
  for (const [key, entry] of groups.entries()) {
    if (entry.occurrences.length < 2) continue;
    if (
      best === null ||
      entry.occurrences.length > best.occurrences.length ||
      (entry.occurrences.length === best.occurrences.length &&
        key.length > normalizeWord(best.text).length)
    ) {
      best = entry;
      bestKey = key;
    }
  }
  if (best === null || bestKey === null) return null;

  const others: { text: string; startMs: number; endMs: number }[] = [];
  for (const token of tokens) {
    if (normalizeWord(token.text) === bestKey) continue;
    const text = cleanWord(token.text);
    if (text.length === 0) continue;
    others.push({ text, startMs: token.startMs, endMs: token.endMs });
  }
  return {
    text: cleanWord(best.text),
    occurrences: best.occurrences,
    others,
  };
}

function normalizeWord(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-zà-öø-ÿ0-9]/g, "");
}

/** Retire la ponctuation autour d'un mot, sans toucher aux apostrophes internes. */
function cleanWord(text: string): string {
  return text
    .replace(/[.,;:!?…«»“”"()[\]{}]/g, "")
    .replace(/^-+|-+$/g, "")
    .trim();
}

function drawRepeatedWord(
  ctx: CanvasRenderingContext2D,
  repeat: RepeatedWord,
  occurrence: { startMs: number; endMs: number },
  ms: number,
  width: number,
  height: number,
  options: LyricsDrawOptions,
): void {
  const duration = Math.max(1, occurrence.endMs - occurrence.startMs);
  const alpha = envelope(
    ms,
    occurrence.startMs,
    occurrence.endMs + CUE_TAIL_MS,
    Math.min(60, duration * 0.25),
    Math.min(CUE_FADE_OUT_MS, duration * 0.45),
  );
  if (alpha <= 0.01) return;

  // Coup sec à l'occurrence, puis repos : le motif ne respire pas avec le
  // beat, sinon son apparition se confond avec un temps fort de la lumière.
  const age = Math.max(0, ms - occurrence.startMs) / 1000;
  const hit = options.reduced ? 0 : Math.max(0, 1 - age / 0.18);

  const text = repeat.text.toUpperCase();
  const maxWidth = width * 0.92;
  let size = Math.min(width * 0.22, height * 0.32);
  ctx.font = `900 ${size}px ${FONT_STACK}`;
  const measured = ctx.measureText(text).width;
  if (measured > maxWidth) {
    size = Math.max(22, size * (maxWidth / measured));
    ctx.font = `900 ${size}px ${FONT_STACK}`;
  }

  // Frappe franche : le mot arrive plus gros et se pose, au lieu de battre.
  const scale = 1 + 0.16 * hit;
  const y = height * 0.43;

  ctx.globalAlpha = alpha;
  ctx.translate(width * 0.5, y);
  ctx.scale(scale, scale);

  // Mot répété : blanc, souffle à la couleur du morceau, sans contour ni biais.
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = accentColor(options.palette, 0.9);
  // Le halo s'allume sur le coup et retombe aussitôt : signature propre au
  // motif, absente des mots ordinaires et des beats.
  ctx.shadowBlur = options.reduced ? 0 : Math.min(size * (0.34 + 0.5 * hit), 104);
  ctx.fillText(text, 0, 0);

  // Le mot variable (« x », « y », « z ») apparaît plus petit sous le motif.
  const companion = activeOther(repeat.others, occurrence, ms);
  if (companion !== null) {
    const shown = envelope(ms, companion.startMs, companion.endMs + 220, 70, 170);
    if (shown > 0.01) {
      const small = size * 0.28;
      ctx.globalAlpha = alpha * shown;
      ctx.font = `700 ${small}px ${FONT_STACK}`;
      ctx.shadowColor = accentColor(options.palette, 0.7);
      ctx.shadowBlur = options.reduced ? 0 : small * 0.5;
      ctx.fillStyle = accentSolid(options.palette);
      ctx.fillText(companion.text.toUpperCase(), 0, size * 0.52);
    }
  }
}

/** Mot variable chanté à cet instant, ou juste avant/après l'occurrence. */
function activeOther(
  others: { text: string; startMs: number; endMs: number }[],
  occurrence: { startMs: number; endMs: number } | null,
  ms: number,
): { text: string; startMs: number; endMs: number } | null {
  for (const other of others) {
    if (other.startMs - 120 <= ms && ms <= other.endMs + 220) return other;
    if (occurrence !== null && other.startMs >= occurrence.startMs - 150 && other.startMs <= occurrence.endMs + 250) {
      return other;
    }
  }
  return null;
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

/**
 * Ligne criée : un mot à la fois, en très gros.
 *
 * Une punchline est souvent longue ; l'afficher d'un bloc la rend illisible.
 * On suit donc les timings des mots, en gardant le mot visible jusqu'au suivant.
 */
function drawLineWord(
  ctx: CanvasRenderingContext2D,
  ms: number,
  width: number,
  height: number,
  options: LyricsDrawOptions,
  emphasised: boolean,
  current: LyricWord | null,
  adlib = false,
): void {
  if (current === null) return;
  paintWord(
    ctx,
    current.text,
    current.startMs,
    current.endMs,
    adlib ? 0.35 : emphasised ? 0.95 : 0.55,
    false,
    ms,
    width,
    height,
    options,
    adlib ? 0.55 : emphasised ? 1 : 0.55,
    adlib,
  );
}

/**
 * Mots de la ligne, avec des timings estimés si le morceau n'en fournit pas.
 *
 * Une répartition égale dérive vite : « anticonstitutionnellement » dure bien
 * plus longtemps que « de ». On pondère donc chaque mot par son nombre de
 * syllabes, ce qui reste une estimation mais suit le débit réel.
 */
function withTimings(line: LyricLine): LyricWord[] {
  if (line.words.length > 0) return line.words;
  const words = line.text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];
  const weights = words.map(syllables);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const span = Math.max(1, line.endMs - line.startMs);
  let elapsed = 0;
  return words.map((word, index) => {
    const start = line.startMs + Math.round((span * elapsed) / total);
    elapsed += weights[index]!;
    const end = line.startMs + Math.round((span * elapsed) / total);
    return { text: word, startMs: start, endMs: end };
  });
}

/** Estimation grossière : une syllabe par groupe de voyelles. */
function syllables(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-zà-öø-ÿ'-]/g, "");
  const groups = clean.match(/[aeiouyàâäéèêëîïôöùûüÿœæ]+/g);
  return Math.max(1, groups?.length ?? 1);
}

function paintWord(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  startMs: number,
  endMs: number,
  impact: number,
  isTitle: boolean,
  ms: number,
  width: number,
  height: number,
  options: LyricsDrawOptions,
  sizeScale = 1,
  adlib = false,
): void {
  const word = rawText.trim();
  if (word.length === 0) return;
  const duration = Math.max(1, endMs - startMs);
  const alpha = envelope(
    ms,
    startMs,
    endMs + CUE_TAIL_MS,
    Math.min(CUE_FADE_IN_MS, duration * 0.35),
    Math.min(CUE_FADE_OUT_MS, duration * 0.45),
  );
  if (alpha <= 0.01) return;

  const text = word.toUpperCase();
  const maxWidth = width * 0.88;
  let size = Math.min(width * 0.17, height * 0.26) * (isTitle ? 1.08 : 1) * sizeScale;
  ctx.font = `800 ${size}px ${FONT_STACK}`;
  const measured = ctx.measureText(text).width;
  if (measured > maxWidth) {
    size = Math.max(18, size * (maxWidth / measured));
    ctx.font = `800 ${size}px ${FONT_STACK}`;
  }

  const age = Math.max(0, ms - startMs) / 1000;
  const attack = options.reduced ? 0 : 1 - clamp01(age / 0.18);
  const pulse = options.reduced ? 0 : 0.04 * options.beat;
  const scale = 0.94 + 0.06 * (1 - attack) + pulse;
  const y = height * (0.46 - 0.02 * impact);

  ctx.globalAlpha = alpha;
  ctx.translate(width * 0.5, y);
  ctx.scale(scale, scale);
  // Le titre se distingue par sa couleur d'accent, pas par sa taille : c'est
  // une signature, pas un mot marquant de plus. Un adlib reste en retrait :
  // blanc atténué, halo court, il ne prend jamais la vedette.
  ctx.fillStyle = adlib ? "rgba(255,255,255,0.68)" : isTitle ? accentSolid(options.palette) : "#ffffff";
  ctx.shadowColor = accentColor(options.palette, adlib ? 0.45 : 0.85);
  const blurCeiling = adlib ? 18 : isTitle ? 64 : 52;
  ctx.shadowBlur = options.reduced ? 0 : Math.min(size * (adlib ? 0.2 : 0.28 + 0.3 * impact), blurCeiling);
  ctx.fillText(text, 0, 0);
}

/**
 * Phrase importante (refrain, ligne criée) : le texte entier, sur une à trois
 * lignes, avec le mot en cours en couleur d'accent.
 *
 * Le mot en cours est mis en couleur d'accent, les mots déjà chantés sont
 * atténués. Une phrase longue rétrécit jusqu'à tenir, plutôt que d'être coupée.
 * Un adlib entre parenthèses est rendu plus petit, comme un souffle derrière la
 * voix principale ; une phrase entièrement adlib (`adlib`) est toute en retrait.
 */
function drawPhrase(
  ctx: CanvasRenderingContext2D,
  line: LyricLine,
  ms: number,
  width: number,
  height: number,
  options: LyricsDrawOptions,
  scaleFactor: number,
  adlib = false,
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
  const tokens: LyricWord[] = timed
    ? line.words
    : [...line.text.matchAll(/\S+/g)].map((match) => ({
        text: match[0],
        startMs: 0,
        endMs: 0,
      }));
  if (tokens.length === 0) return;
  const adlibFlags = adlibTokenFlags(line, tokens);
  const maxWidth = width * 0.9;
  let size = Math.min(width * 0.15, height * 0.21) * scaleFactor;
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
  ctx.shadowColor = accentColor(options.palette, adlib ? 0.45 : 0.65);
  ctx.shadowBlur = options.reduced ? 0 : Math.min(size * (adlib ? 0.18 : 0.28), adlib ? 18 : 40);

  const space = ctx.measureText(" ").width;
  rows.forEach((row, rowIndex) => {
    const texts = row.map((tokenIndex) => tokens[tokenIndex]!.text.trim().toUpperCase());
    const sizes = row.map((tokenIndex) =>
      adlib || adlibFlags[tokenIndex] !== true ? size : size * ADLIB_SCALE,
    );
    const widths = texts.map((text, position) => {
      ctx.font = `800 ${sizes[position]!}px ${FONT_STACK}`;
      return ctx.measureText(text).width;
    });
    const rowWidth =
      widths.reduce((sum, value) => sum + value, 0) + space * Math.max(0, row.length - 1);
    let x = width * 0.5 - rowWidth * 0.5;
    const y = startY + rowIndex * lineHeight;
    row.forEach((tokenIndex, position) => {
      const token = tokens[tokenIndex]!;
      const text = texts[position]!;
      const secondary = adlib || adlibFlags[tokenIndex] === true;
      const current = timed && token.startMs <= ms && ms < token.endMs;
      const past = timed && ms >= token.endMs;
      ctx.font = `800 ${sizes[position]!}px ${FONT_STACK}`;
      ctx.fillStyle = secondary
        ? "rgba(255,255,255,0.68)"
        : !timed
          ? "rgba(255,255,255,0.92)"
          : current
            ? accentSolid(options.palette)
            : past
              ? "rgba(255,255,255,0.55)"
              : "rgba(255,255,255,0.92)";
      ctx.textAlign = "left";
      ctx.fillText(text, x, y);
      x += widths[position]! + space;
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
