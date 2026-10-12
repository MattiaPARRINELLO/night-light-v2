import { App } from "./browser/app";

function boot(): void {
  try {
    const app = new App();
    (window as unknown as { nightLight: App }).nightLight = app;
  } catch (error) {
    console.error("Impossible de démarrer Night Light", error);
    const live = document.getElementById("live");
    if (live !== null) {
      live.textContent =
        "Impossible de démarrer l'application dans ce navigateur. Essaie une version récente de Chrome, Edge, Firefox ou Safari.";
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
