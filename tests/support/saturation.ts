/**
 * Mesure de saturation d'une image rendue : part de pixels « proches du blanc ».
 *
 * Un pixel est proche du blanc si sa luminance est > 0,92 **et** sa saturation
 * < 0,15. C'est la définition adoptée pour juger les drops de la vague 2 :
 * elle attrape le blanc laiteux (tous canaux hauts, écart faible) sans compter
 * un cyan clair ou un jaune pâle.
 *
 * Formules (documentées, stables) :
 * - luminance : Rec. 709 sur les canaux sRGB normalisés 0..1
 *   (`0,2126 R + 0,7152 G + 0,0722 B`) ;
 * - saturation : HSV, `(max − min) / max`, 0 pour un noir parfait.
 *
 * Le tableau attendu est un `Uint8ClampedArray` RGBA, tel que renvoyé par
 * `CanvasRenderingContext2D.getImageData(...).data`.
 */

export interface WhitePixelStats {
  /** Nombre de pixels évalués. */
  total: number;
  /** Nombre de pixels proches du blanc. */
  white: number;
  /** Part de pixels proches du blanc, 0..1. */
  ratio: number;
}

export interface WhitePixelOptions {
  luminanceThreshold?: number;
  saturationThreshold?: number;
}

/** Compte les pixels proches du blanc d'une image RGBA. */
export function whitePixels(
  data: ArrayLike<number>,
  options: WhitePixelOptions = {},
): WhitePixelStats {
  const luminanceThreshold = options.luminanceThreshold ?? 0.92;
  const saturationThreshold = options.saturationThreshold ?? 0.15;
  let white = 0;
  let total = 0;
  for (let index = 0; index + 3 < data.length; index += 4) {
    const r = (data[index] ?? 0) / 255;
    const g = (data[index + 1] ?? 0) / 255;
    const b = (data[index + 2] ?? 0) / 255;
    total += 1;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luminance <= luminanceThreshold) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    if (saturation < saturationThreshold) white += 1;
  }
  return { total, white, ratio: total === 0 ? 0 : white / total };
}

/** Part de pixels proches du blanc, 0..1. */
export function nearWhiteRatio(data: ArrayLike<number>, options?: WhitePixelOptions): number {
  return whitePixels(data, options).ratio;
}
