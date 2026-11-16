/**
 * Détection du backend de rendu.
 *
 * Canvas 2D ne dit pas s'il est accéléré. Le seul signal fiable disponible est
 * le renderer WebGL du navigateur : dans Chromium, Firefox et Safari, le canvas
 * 2D et WebGL partagent le même processus GPU, et une machine sans accélération
 * matérielle expose SwiftShader, llvmpipe ou un équivalent logiciel. On s'en
 * sert donc comme sonde, sans jamais déclencher de fausse alerte quand le
 * navigateur masque l'information (`kind: "unknown"`).
 */

export type RenderBackendKind = "gpu" | "software" | "unknown";

export interface RenderBackend {
  kind: RenderBackendKind;
  /** Libellé court pour le HUD. */
  label: string;
  /** Renderer brut, pour le panneau de debug. */
  detail: string;
}

/**
 * Renderers qui trahissent une rastérisation logicielle.
 *
 * `ANGLE (... SwiftShader ...)` est le cas Chromium sans GPU ; `llvmpipe` et
 * `softpipe` viennent de Mesa ; `Microsoft Basic Render Driver` est le pilote
 * de secours de Windows.
 */
const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render driver|microsoft basic/i;

/** Classe un renderer WebGL. Fonction pure, testable sans navigateur. */
export function classifyRenderer(renderer: string | null | undefined): RenderBackend {
  if (renderer === null || renderer === undefined || renderer.trim() === "") {
    return { kind: "unknown", label: "inconnu", detail: "WebGL indisponible" };
  }
  if (SOFTWARE_RENDERER.test(renderer)) {
    return { kind: "software", label: "logiciel", detail: renderer };
  }
  return { kind: "gpu", label: "GPU", detail: renderer };
}

/** Sonde le navigateur une fois, sans laisser de contexte WebGL vivant. */
export function detectRenderBackend(): RenderBackend {
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  try {
    canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (gl === null) return classifyRenderer(null);
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer =
      debugInfo !== null
        ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return classifyRenderer(renderer);
  } catch {
    return classifyRenderer(null);
  } finally {
    // Le contexte a été perdu juste au-dessus ; la référence disparaît avec la
    // fonction. Rien d'autre à libérer.
    gl = null;
    canvas = null;
  }
}
