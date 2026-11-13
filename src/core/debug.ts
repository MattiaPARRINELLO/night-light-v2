/**
 * Journal live partagé.
 *
 * Double sortie : la console du navigateur (une ligne par événement, lisible
 * d'un coup d'œil) et un tampon circulaire que l'overlay (touche D) affiche en
 * direct.
 *
 * Le journal n'est pas un mode debug : il raconte ce qui se passe vraiment
 * pendant un show — morceau détecté, téléchargement, analyse, paroles,
 * synchronisation — avec des valeurs déjà formatées (durées, unités, oui/non)
 * et sans objets bruts à déplier. `dbgThrottled` existe pour les valeurs qui
 * changent en continu, afin de ne pas noyer la console.
 */

export type DebugCategory =
  | "boot"
  | "capture"
  | "analyse"
  | "sync"
  | "live"
  | "show"
  | "erreur"
  | "attention";

export interface DebugEntry {
  /** Horodatage epoch (ms). */
  at: number;
  category: DebugCategory;
  message: string;
  data?: unknown;
  /**
   * Message de routine (valeurs rafraîchies en continu). L'overlay les limite
   * à quelques lignes pour laisser la place aux vrais événements.
   */
  routine?: boolean;
}

const CATEGORY_LABEL: Record<DebugCategory, string> = {
  boot: "DÉMARRAGE",
  capture: "CAPTURE",
  analyse: "MORCEAU",
  sync: "SYNC",
  live: "LIVE",
  show: "SHOW",
  erreur: "ERREUR",
  attention: "ATTENTION",
};

/** Couleur du préfixe dans la console, une teinte par domaine. */
const CATEGORY_STYLE: Record<DebugCategory, string> = {
  boot: "color:#8b95a5",
  capture: "color:#3fc5d4",
  analyse: "color:#b48cf2",
  sync: "color:#6f9bff",
  live: "color:#2fbfa8",
  show: "color:#4cc46a",
  erreur: "color:#ff5c5c;font-weight:700",
  attention: "color:#e8a33d;font-weight:700",
};

const MAX_ENTRIES = 240;
const DETAIL_LIMIT = 260;

function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Nombre sans zéros inutiles : 128, 3.2, 0.42. */
function numberText(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "oui" : "non";
  if (typeof value === "number") return numberText(value);
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) {
    const shown = value.slice(0, 6).map(valueText).join(", ");
    return value.length > 6 ? `${shown}…` : shown;
  }
  try {
    return JSON.stringify(value) ?? "—";
  } catch {
    return "—";
  }
}

/**
 * Rend les données d'un événement sous forme `clé=valeur`, sur la même ligne.
 * Une chaîne seule est ajoutée telle quelle ; un objet vide ne produit rien.
 */
function detailText(data: unknown): string {
  if (data === undefined) return "";
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    const text = valueText(data);
    return text === "" ? "" : ` · ${text}`;
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${valueText(value)}`);
  }
  return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}

function clip(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/** Durée lisible : « 320 ms », « 2,4 s », « 1 min 12 s ». */
export function msText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(".", ",")} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} min ${rest} s`;
}

class DebugLog {
  private entries: DebugEntry[] = [];
  private lastSeen = new Map<string, number>();

  push(category: DebugCategory, message: string, data?: unknown, echo = true, routine = false): void {
    const at = Date.now();
    this.entries.push({ at, category, message, data, routine });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (!echo) return;
    const label = CATEGORY_LABEL[category].padEnd(9);
    const line = `${label} ${stamp(at)}  ${message}${clip(detailText(data))}`;
    if (category === "erreur") {
      console.error(`%c${line}`, CATEGORY_STYLE[category]);
    } else if (category === "attention") {
      console.warn(`%c${line}`, CATEGORY_STYLE[category]);
    } else {
      console.log(`%c${line}`, CATEGORY_STYLE[category]);
    }
  }

  /**
   * Version limitée en fréquence : une seule ligne par `intervalMs` pour une
   * même clé, la valeur la plus récente gagne.
   */
  pushThrottled(
    key: string,
    category: DebugCategory,
    message: string,
    data?: unknown,
    intervalMs = 500,
  ): void {
    const now = Date.now();
    const previous = this.lastSeen.get(key);
    if (previous !== undefined && now - previous < intervalMs) return;
    this.lastSeen.set(key, now);
    this.push(category, message, data, true, true);
  }

  /** Lignes formatées pour l'overlay, de la plus récente à la plus ancienne. */
  lines(total = 12, routineMax = 6): string[] {
    const out: string[] = [];
    let routine = 0;
    for (let index = this.entries.length - 1; index >= 0 && out.length < total; index -= 1) {
      const entry = this.entries[index];
      if (entry === undefined) continue;
      if (entry.routine === true) {
        routine += 1;
        if (routine > routineMax) continue;
      }
      out.push(`${stamp(entry.at)} ${CATEGORY_LABEL[entry.category].padEnd(9)} ${entry.message}`);
    }
    return out;
  }

  clear(): void {
    this.entries = [];
    this.lastSeen.clear();
  }
}

export const debugLog = new DebugLog();

export function dbgLog(category: DebugCategory, message: string, data?: unknown, echo = true, routine = false): void {
  debugLog.push(category, message, data, echo, routine);
}

export function dbgThrottled(
  key: string,
  category: DebugCategory,
  message: string,
  data?: unknown,
  intervalMs = 500,
): void {
  debugLog.pushThrottled(key, category, message, data, intervalMs);
}
