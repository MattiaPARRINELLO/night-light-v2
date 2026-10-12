import { clamp, clamp01, mix } from "./series";

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const light = clamp01(l);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: Rgb;
  if (hp < 1) rgb = { r: c, g: x, b: 0 };
  else if (hp < 2) rgb = { r: x, g: c, b: 0 };
  else if (hp < 3) rgb = { r: 0, g: c, b: x };
  else if (hp < 4) rgb = { r: 0, g: x, b: c };
  else if (hp < 5) rgb = { r: x, g: 0, b: c };
  else rgb = { r: c, g: 0, b: x };
  const m = light - c / 2;
  return {
    r: Math.round(clamp((rgb.r + m) * 255, 0, 255)),
    g: Math.round(clamp((rgb.g + m) * 255, 0, 255)),
    b: Math.round(clamp((rgb.b + m) * 255, 0, 255)),
  };
}

export function shorthand(color: Rgb, alpha = 1): string {
  if (alpha >= 1) return `rgb(${color.r},${color.g},${color.b})`;
  return `rgba(${color.r},${color.g},${color.b},${clamp01(alpha).toFixed(3)})`;
}

export function mixRgb(a: Rgb, b: Rgb, ratio: number): Rgb {
  return {
    r: Math.round(mix(a.r, b.r, ratio)),
    g: Math.round(mix(a.g, b.g, ratio)),
    b: Math.round(mix(a.b, b.b, ratio)),
  };
}

/** Décale une teinte en gardant l'enroulement 0..360. */
export function shiftHue(hue: number, delta: number): number {
  return (((hue + delta) % 360) + 360) % 360;
}
