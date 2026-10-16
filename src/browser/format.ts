/** Formatage court, partagé par l'overlay de debug et le rendu. */

export function num(value: number | undefined): string {
  return Number.isFinite(value) ? (value as number).toFixed(3) : "—";
}

export function seconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return `${(ms / 1000).toFixed(2)} s`;
}
