/**
 * Journal de debug partagé.
 *
 * Double sortie : la console du navigateur (ce qu'il se passe, événement par
 * événement) et un tampon circulaire que l'overlay (touche D) affiche en direct.
 *
 * La règle est simple : les événements (ouverture de capture, changement de
 * morceau, resynchronisation…) sont toujours écrits dans la console ; les
 * valeurs rafraîchies en continu passent par `dbgThrottled` pour ne pas noyer
 * la console sous des centaines de lignes par seconde.
 */

export type DebugCategory =
  | "boot"
  | "capture"
  | "analyse"
  | "sync"
  | "live"
  | "show"
  | "erreur";

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

const CATEGORY_ICON: Record<DebugCategory, string> = {
  boot: "boot",
  capture: "capture",
  analyse: "analyse",
  sync: "sync",
  live: "live",
  show: "show",
  erreur: "ERREUR",
};

const MAX_ENTRIES = 240;

function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function preview(data: unknown): string {
  if (data === undefined) return "";
  try {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    return raw === undefined ? "" : ` ${raw.length > 220 ? `${raw.slice(0, 220)}…` : raw}`;
  } catch {
    return " (données non sérialisables)";
  }
}

class DebugLog {
  private entries: DebugEntry[] = [];
  private lastSeen = new Map<string, number>();

  push(category: DebugCategory, message: string, data?: unknown, echo = true, routine = false): void {
    const at = Date.now();
    this.entries.push({ at, category, message, data, routine });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (echo) {
      const line = `[${CATEGORY_ICON[category]}] ${stamp(at)} ${message}${preview(data)}`;
      if (category === "erreur") console.error(line, data ?? "");
      else console.log(line, data ?? "");
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
      out.push(`${stamp(entry.at)} ${CATEGORY_ICON[entry.category].padEnd(7)} ${entry.message}`);
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
