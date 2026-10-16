/**
 * Chargement portable de Playwright pour les vérifications navigateur.
 *
 * Playwright n'est nécessaire qu'aux tests `check:*` : on le résout depuis les
 * dépendances du projet, avec un message explicite s'il manque au lieu d'un
 * chemin en dur propre à une machine. `bun test` n'en dépend pas.
 */
export async function loadChromium() {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch (error) {
    console.error(
      "Playwright requis pour cette vérification, mais introuvable.\n" +
        "Installe-le une fois :\n" +
        "  bun add -D playwright\n" +
        "  bunx playwright install chromium\n" +
        `Cause : ${error instanceof Error ? error.message : error}`,
    );
    process.exit(2);
  }
}
