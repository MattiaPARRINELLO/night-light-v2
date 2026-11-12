import { clamp01, hash01 } from "../series";
import { contrastHue } from "./harmony";
import type { FrameState } from "./types";
import { paint } from "./util";

/**
 * Décor et structures du concert.
 *
 * Appelé une fois par image avant les faisceaux, en `source-over`. Ce ne sont
 * pas des effets lumineux : ce sont les éléments physiques d'une scène de
 * concert — praticable, escaliers, tours de treillis, lignes de façade, murs
 * d'échafaudage et rideaux de câbles. Ils donnent de la profondeur aux lyres et
 * remplissent le cadre sans laser ni artifice de rave.
 */

/** Trait de structure : fin, métallique, légèrement teinté par la scène. */
function trait(
  ctx: CanvasRenderingContext2D,
  couleur: string,
  largeur: number,
  trace: () => void,
): void {
  ctx.strokeStyle = couleur;
  ctx.lineWidth = largeur;
  ctx.beginPath();
  trace();
  ctx.stroke();
}

export function dessinerSceneConcert(ctx: CanvasRenderingContext2D, f: FrameState): void {
  const { width: w, height: h } = f;
  const teinte = contrastHue(f);
  const alpha = (f.reduced ? 0.45 : 1) * f.alpha;
  const metal = paint(teinte, 0.2, 0.24, 0.5 * alpha);
  const metalFin = paint(teinte, 0.24, 0.42, 0.32 * alpha);
  const lueur = paint(f.palette.hue, 0.7, 0.55, 0.24 * alpha);
  const sol = h * 0.78;

  // Praticable : le plateau physique, avec sa face avant et sa ligne de fuite.
  const deck = ctx.createLinearGradient(0, sol, 0, h);
  deck.addColorStop(0, paint(teinte, 0.14, 0.16, 0.85 * alpha));
  deck.addColorStop(1, paint(teinte, 0.16, 0.07, 0.95 * alpha));
  ctx.fillStyle = deck;
  ctx.beginPath();
  ctx.moveTo(w * 0.04, sol);
  ctx.lineTo(w * 0.96, sol);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();

  // Liseré de scène : une ligne continue, jamais clignotante.
  trait(ctx, lueur, Math.max(1.2, w * 0.0016), () => {
    ctx.moveTo(w * 0.04, sol);
    ctx.lineTo(w * 0.96, sol);
  });

  // Deux escaliers latéraux qui montent sur le praticable.
  for (const cote of [0.08, 0.92] as const) {
    const marches = 5;
    const largeur = w * 0.09;
    const x0 = cote * w - largeur * 0.5;
    for (let marche = 0; marche < marches; marche += 1) {
      const t = marche / marches;
      const x = x0 + t * largeur * 0.18;
      const y = sol + t * (h - sol) * 0.5;
      trait(ctx, metal, Math.max(0.6, w * 0.0006), () => {
        ctx.moveTo(x, y);
        ctx.lineTo(x + largeur * (1 - t * 0.18), y);
      });
    }
  }

  // Deux tours de treillis latérales, avec croisillons.
  for (const cote of [0.055, 0.945] as const) {
    const x = cote * w;
    const demi = w * 0.012;
    const haut = h * 0.1;
    const bas = sol;
    trait(ctx, metal, Math.max(0.8, w * 0.0007), () => {
      ctx.moveTo(x - demi, haut);
      ctx.lineTo(x - demi, bas);
      ctx.moveTo(x + demi, haut);
      ctx.lineTo(x + demi, bas);
    });
    const barreaux = Math.max(4, Math.round((bas - haut) / (h * 0.09)));
    for (let index = 0; index < barreaux; index += 1) {
      const y0 = haut + ((bas - haut) * index) / barreaux;
      const y1 = haut + ((bas - haut) * (index + 1)) / barreaux;
      trait(ctx, metalFin, Math.max(0.45, w * 0.0004), () => {
        ctx.moveTo(x - demi, y0);
        ctx.lineTo(x + demi, y1);
        if (index % 2 === 0) {
          ctx.moveTo(x + demi, y0);
          ctx.lineTo(x - demi, y1);
        }
      });
    }
  }

  // Pont arrière et suspentes : une deuxième profondeur derrière la scène.
  const pontY = h * 0.14;
  trait(ctx, metalFin, Math.max(0.9, w * 0.0008), () => {
    ctx.moveTo(w * 0.14, pontY);
    ctx.lineTo(w * 0.86, pontY);
  });
  for (let index = 0; index < 12; index += 1) {
    const x = w * (0.16 + (0.68 * index) / 11);
    const longueur = h * (0.1 + hash01(index * 31 + f.seed) * 0.12);
    trait(ctx, paint(teinte, 0.2, 0.4, 0.16 * alpha), Math.max(0.4, w * 0.00035), () => {
      ctx.moveTo(x, pontY);
      ctx.lineTo(x, pontY + longueur);
    });
  }

  // Lignes de façade suspendues à gauche et à droite : six à huit enceintes
  // par côté, légèrement inclinées vers la salle.
  const enceintes = 7;
  for (const side of [0, 1] as const) {
    const ancrageX = w * (side === 0 ? 0.16 : 0.84);
    const direction = side === 0 ? -1 : 1;
    for (let index = 0; index < enceintes; index += 1) {
      const t = index / (enceintes - 1);
      const x = ancrageX + direction * t * w * 0.055;
      const y = h * 0.08 + t * h * 0.23;
      const largeur = w * (0.026 - 0.006 * t);
      const hauteur = h * 0.021;
      ctx.fillStyle = paint(teinte, 0.1, 0.1, 0.75 * alpha);
      ctx.fillRect(x - largeur / 2, y, largeur, hauteur);
      ctx.strokeStyle = metalFin;
      ctx.lineWidth = Math.max(0.4, w * 0.0004);
      ctx.beginPath();
      ctx.moveTo(x, h * 0.02);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  }

  // Mur d'échafaudage derrière le praticable : grille discrète, profondeur.
  ctx.strokeStyle = paint(teinte, 0.18, 0.32, 0.13 * alpha);
  ctx.lineWidth = Math.max(0.4, w * 0.00035);
  ctx.beginPath();
  for (let index = 0; index <= 10; index += 1) {
    const x = w * (0.18 + 0.64 * (index / 10));
    ctx.moveTo(x, h * 0.27);
    ctx.lineTo(x, sol);
  }
  for (let index = 0; index <= 5; index += 1) {
    const y = h * (0.27 + 0.51 * (index / 5));
    ctx.moveTo(w * 0.18, y);
    ctx.lineTo(w * 0.82, y);
  }
  ctx.stroke();

  // Deux praticables latéraux bas, pour poser des musiciens ou du matériel.
  for (const cote of [0.22, 0.78] as const) {
    const x = cote * w;
    const largeur = w * 0.16;
    const hauteur = h * 0.055;
    ctx.fillStyle = paint(teinte, 0.12, 0.12, 0.7 * alpha);
    ctx.fillRect(x - largeur / 2, sol - hauteur, largeur, hauteur);
    ctx.strokeStyle = metalFin;
    ctx.lineWidth = Math.max(0.5, w * 0.0005);
    ctx.beginPath();
    ctx.moveTo(x - largeur / 2, sol - hauteur);
    ctx.lineTo(x + largeur / 2, sol - hauteur);
    ctx.lineTo(x + largeur / 2, sol);
    ctx.lineTo(x - largeur / 2, sol);
    ctx.lineTo(x - largeur / 2, sol - hauteur);
    ctx.stroke();
  }

  // Deux rideaux de câbles qui tombent du pont arrière.
  for (const cote of [0.31, 0.69] as const) {
    const baseX = cote * w;
    for (let index = 0; index < 5; index += 1) {
      const x = baseX + (index - 2) * w * 0.006;
      const courbe = Math.sin(f.t * 0.12 + index) * w * 0.004 * clamp01(f.energy);
      trait(ctx, paint(teinte, 0.16, 0.4, 0.18 * alpha), Math.max(0.35, w * 0.0003), () => {
        ctx.moveTo(x, pontY);
        ctx.quadraticCurveTo(x + courbe, h * 0.3, x + courbe * 1.6, sol);
      });
    }
  }
}
