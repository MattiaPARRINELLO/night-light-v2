/**
 * Faux contexte 2D : enregistre chaque opération pour vérifier que le rendu est
 * une fonction du temps musical (indispensable pour rester synchronisé après
 * une pause ou un retour en arrière).
 *
 * Partagé par les tests qui dessinent des familles sans navigateur. Les
 * transformations de contexte sont enregistrées comme les autres opérations,
 * sans être appliquées aux coordonnées.
 */
export function fakeContext() {
  const operations: string[] = [];
  let font = "16px sans-serif";
  const gradient = {
    addColorStop: (offset: number, color: string) => operations.push(`stop:${offset}:${color}`),
  };
  const ctx = {
    canvas: { width: 0, height: 0 },
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    strokeStyle: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    shadowColor: "",
    shadowBlur: 0,
    // Le texte n'est enregistré que s'il est réellement visible : c'est ce qui
    // permet de vérifier qu'une ligne de paroles ne disparaît pas.
    get font() {
      return font;
    },
    set font(value: string) {
      font = value;
    },
    measureText: (text: string) => {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
      return { width: text.length * size * 0.55 };
    },
    fillText: (text: string) => {
      if (ctx._alpha > 0.02) operations.push(`fillText:${text}`);
    },
    // Les styles et l'alpha sont enregistrés à l'affectation : sans ça, on ne
    // peut pas vérifier qu'un élément est réellement visible.
    _alpha: 1,
    _fill: "",
    _filter: "none",
    get filter() {
      return this._filter;
    },
    set filter(value: string) {
      this._filter = value;
      operations.push(`filter:${value}`);
    },
    get fillStyle() {
      return this._fill;
    },
    set fillStyle(value: string) {
      this._fill = value;
      operations.push(`fillStyle:${value}`);
    },
    get globalAlpha() {
      return this._alpha;
    },
    set globalAlpha(value: number) {
      this._alpha = value;
      operations.push(`alpha:${Number(value.toFixed(4))}`);
    },
    setTransform: () => operations.push("setTransform"),
    save: () => operations.push("save"),
    restore: () => operations.push("restore"),
    translate: (x: number, y: number) =>
      operations.push(`translate:${x.toFixed(1)},${y.toFixed(1)}`),
    rotate: (angle: number) => operations.push(`rotate:${angle.toFixed(3)}`),
    scale: (x: number, y: number) => operations.push(`scale:${x.toFixed(3)},${y.toFixed(3)}`),
    clearRect: () => operations.push("clearRect"),
    drawImage: () => operations.push("drawImage"),
    fillRect: (x: number, y: number, w: number, h: number) =>
      operations.push(`fillRect:${x.toFixed(1)},${y.toFixed(1)},${w.toFixed(1)},${h.toFixed(1)}`),
    beginPath: () => operations.push("beginPath"),
    closePath: () => operations.push("closePath"),
    moveTo: (x: number, y: number) => operations.push(`moveTo:${x.toFixed(1)},${y.toFixed(1)}`),
    lineTo: (x: number, y: number) => operations.push(`lineTo:${x.toFixed(1)},${y.toFixed(1)}`),
    arc: (x: number, y: number, r: number) => operations.push(`arc:${x.toFixed(1)},${y.toFixed(1)},${r.toFixed(1)}`),
    quadraticCurveTo: (x1: number, y1: number, x2: number, y2: number) =>
      operations.push(`quadraticCurveTo:${x1.toFixed(1)},${y1.toFixed(1)},${x2.toFixed(1)},${y2.toFixed(1)}`),
    fill: () => operations.push("fill"),
    stroke: () => operations.push("stroke"),
    createLinearGradient: (...args: number[]) => {
      operations.push(`linear:${args.map((value) => value.toFixed(1)).join(",")}`);
      return gradient;
    },
    createRadialGradient: (...args: number[]) => {
      operations.push(`radial:${args.map((value) => value.toFixed(1)).join(",")}`);
      return gradient;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, operations };
}
