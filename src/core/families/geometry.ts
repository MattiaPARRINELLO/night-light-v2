/**
 * Positions d'une rangée de projecteurs le long d'un bord.
 *
 * La rangée **déborde des deux côtés** : une rangée arrêtée aux bords laisse un
 * trou du côté vers lequel les faisceaux se penchent, puisque la lumière
 * inclinée quitte la zone couverte par les lampes. C'est le défaut que
 * `rowPositions` corrige une fois pour toutes.
 */
export function rowPositions(count: number, width: number, margin: number): number[] {
  if (count < 1) return [];
  if (count === 1) return [width * 0.5];
  const step = (width + margin * 2) / (count - 1);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(-margin + step * i);
  return out;
}
