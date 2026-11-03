# Lyres du pont, duo avec les barres et bordure LED — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter des gestes inédits aux huit lyres du pont, trois familles où elles jouent seules ou avec les barres LED du milieu, et une bordure de diodes permanente qui s'allume d'elle-même aux moments lumineux.

**Architecture:** Les gestes deviennent des cas optionnels de `orientationLyre` (`geste: "auto"` par défaut), consommés par trois nouvelles familles de `CONCERT_FAMILIES`. La bordure est un module autonome `src/core/families/bordure.ts`, dessiné en couche permanente par `render.ts`, avec ses propres déclencheurs analytiques. Aucun état ne traverse les images.

**Tech Stack:** TypeScript, Canvas 2D, bun:test, Vite.

**Spec:** `docs/superpowers/specs/2026-11-03-lyres-et-bordure-led-design.md`

## Global Constraints

- Tout effet reste une fonction pure de `(t, view, scene, frameState)` : aucun état accumulé.
- `geste: "auto"` doit reproduire exactement le comportement actuel de `orientationLyre`.
- Mode réduit : aucune nouvelle famille de concert, bordure plafonnée à `0,3`, sans chenillard ni éclat.
- La bordure respecte `settings.flashes` (0 = aucun éclat) et reste dans la palette du morceau (`lampHue`).
- Après chaque tâche : `bun run typecheck`, `bun run lint`, `bun test tests/unit` verts, puis commit.

## Review Focus

- **Fenêtre étroite / portrait** : la bordure doit rester entièrement dans le cadre (marge calculée sur le petit côté, jamais de coordonnée négative).
- **Pause / seek** : deux appels à la même image doivent produire exactement la même intensité de bordure et les mêmes opérations de dessin.
- **Passage de temps fort** : la poursuite des lyres boucle sans saut d'angle ni clignotement entre deux images.
- **`settings.flashes = 0`** : l'éclat de bordure doit s'éteindre, pas seulement diminuer.
- **Corpus réel** : les trois nouvelles familles doivent être réellement tirables sur les réservoirs existants.

---

### Task 1: Gestes optionnels des lyres

**Files:**
- Modify: `src/core/families/concert-rig.ts` (`orientationLyre`, ~ligne 171)
- Modify: `src/core/families/index.ts` (export du type)
- Test: `tests/unit/concert.test.ts`

**Interfaces:**
- Consumes: `tempsTempsFort`, `beatSwing`, `smoothstep`, `clamp01`, `NOMBRE_LYRES`, `borner`.
- Produces:
  ```ts
  export type GesteLyre = "auto" | "poursuite" | "eventail" | "croisement" | "vague";
  export function orientationLyre(
    f: FrameState,
    view: TrackView,
    index: number,
    role?: SceneRole,
    geste?: GesteLyre,
  ): OrientationLyre;
  ```

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter dans `tests/unit/concert.test.ts`, section « cinématiques des lyres et des barres » :

```ts
test("le geste auto reproduit le comportement historique", () => {
  const view = new TrackView(analysis());
  const f = frame("refrain", 12);
  for (let index = 0; index < NOMBRE_LYRES; index += 1) {
    expect(orientationLyre(f, view, index, "refrain", "auto")).toEqual(
      orientationLyre(f, view, index, "refrain"),
    );
  }
});

test("la poursuite n'allume qu'une tête à la fois et avance", () => {
  const view = new TrackView(analysis());
  const f = frame("refrain", 12);
  const teteActive = (t: number) =>
    Array.from({ length: NOMBRE_LYRES }, (_, index) =>
      orientationLyre({ ...f, t, beatIndex: Math.floor(t / 0.5), beatPhase: view.beatPhase(t) },
        view, index, "refrain", "poursuite").intensite,
    ).map((valeur, index) => (valeur > 0.5 ? index : -1)).filter((index) => index >= 0);
  expect(teteActive(12).length).toBeGreaterThan(0);
  expect(teteActive(12).length).toBeLessThanOrEqual(2);
  expect(teteActive(12)).not.toEqual(teteActive(13));
});

test("chaque geste reste continu d'une image à l'autre", () => {
  const view = new TrackView(analysis());
  const gestes = ["poursuite", "eventail", "croisement", "vague"] as const;
  for (const geste of gestes) {
    const base = frame("refrain", 10);
    let precedent = orientationLyre(base, view, 0, "refrain", geste);
    let angleMax = 0;
    let intensiteMax = 0;
    for (let t = 10 + 1 / 60; t < 20; t += 1 / 60) {
      const courant = orientationLyre(
        { ...base, t, beatIndex: Math.floor(t / 0.5), beatPhase: view.beatPhase(t) },
        view, 0, "refrain", geste,
      );
      angleMax = Math.max(angleMax, Math.abs(courant.angle - precedent.angle));
      intensiteMax = Math.max(intensiteMax, Math.abs(courant.intensite - precedent.intensite));
      precedent = courant;
    }
    expect(angleMax).toBeLessThan(0.02);
    expect(intensiteMax).toBeLessThan(0.02);
  }
});
```

- [ ] **Step 2: Lancer les tests pour vérifier l'échec**

Run: `bun test tests/unit/concert.test.ts`
Expected: FAIL — `geste` n'existe pas / `orientationLyre` renvoie `undefined` pour le 5e argument.

- [ ] **Step 3: Implémenter le type et les gestes**

Dans `concert-rig.ts` :

```ts
export type GesteLyre = "auto" | "poursuite" | "eventail" | "croisement" | "vague";
```

Ajouter le paramètre `geste: GesteLyre = "auto"` à `orientationLyre`. Après le `switch (role)` existant et **avant** le calcul `presence`/`respiration`, si `geste !== "auto"`, remplacer `angle`, `ouverture`, `intensite`, `prisme` par le geste :

- `poursuite` : `position = (tempsTempsFort(f, view) * 0.5) % NOMBRE_LYRES` (positif), `distance` circulaire à `i`, `intensite = 0.12 + 0.88 * (1 - smoothstep(0.55, 1.8, distance))`, `angle = base + (i - centre) * 0.006 + beatSwing(f, view, 0.12, 4, decalage) * 0.6`, `ouverture = 0.018`, `prisme = 0`.
- `eventail` : `angle = base + (i - centre) * 0.2 * (0.85 + 0.15 * Math.sin(f.t * 0.17))`, `ouverture = 0.026`, `intensite = 0.8`, `prisme = f.reduced ? 0 : smoothstep(0.55, 0.85, f.energy) * 0.6`.
- `croisement` : `angle = base + (i - centre) * 0.075 + beatSwing(f, view, 0.18, 8, decalage) * 0.5`, `ouverture = 0.021`, `intensite = 0.85`, `prisme = f.reduced ? 0 : smoothstep(0.6, 0.9, f.energy) * 0.5`.
- `vague` : `angle = base + 0.16 * Math.sin(tempsTempsFort(f, view) * Math.PI * 0.5 - i * 0.55)`, `ouverture = 0.022`, `intensite = 0.7`, `prisme = 0`.

La `presence`/`respiration` finale s'applique à tous les gestes (la poursuite respire donc aussi).

Exporter `GesteLyre` depuis `src/core/families/index.ts`.

- [ ] **Step 4: Vérifier que les tests passent**

Run: `bun test tests/unit/concert.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/families/concert-rig.ts src/core/families/index.ts tests/unit/concert.test.ts
git commit -m "feat(concert): gestes optionnels poursuite, eventail, croisement et vague pour les lyres"
```

---

### Task 2: Familles lyres seules, duo et éventail

**Files:**
- Create: `tests/support/fake_canvas.ts`
- Modify: `tests/unit/render.test.ts` (importer `fakeContext` au lieu de le définir localement)
- Modify: `src/core/families/concert-rig.ts` (`lyresSuspendues`, `barresLed`, `CONCERT_FAMILIES`)
- Modify: `src/core/show.ts` (`FamilyId`, `FAMILY_LABELS`)
- Test: `tests/unit/concert.test.ts`

**Interfaces:**
- Consumes: `orientationLyre(..., geste)`, `softBeam`, `angleBatten`, `cibleRideau`, `lampHue`, `positionLyre`, `positionBatten`.
- Produces: l'objet `CONCERT_FAMILIES` de `src/core/families` contient `"lyres-poursuite"`, `"lyres-duo"`, `"lyres-eventail"` ; `FamilyId` les accepte ; `FAMILY_LABELS` leur donne « lyres en poursuite », « lyres et barres en duo », « éventail de lyres » ; `fakeContext()` est importable depuis `tests/support/fake_canvas.ts`.

- [ ] **Step 1: Écrire les tests qui échouent**

Extraire d'abord `fakeContext` (défini dans `tests/unit/render.test.ts:55-117`) vers `tests/support/fake_canvas.ts` et faire importer la fonction par `render.test.ts`. Aucun changement de comportement.

Dans `tests/unit/concert.test.ts` :

```ts
import { CONCERT_FAMILIES } from "../../src/core/families";
import { fakeContext } from "../support/fake_canvas";

test("les trois nouvelles familles de lyres sont déclarées", () => {
  expect(Object.keys(CONCERT_FAMILIES)).toEqual(
    expect.arrayContaining(["lyres-poursuite", "lyres-duo", "lyres-eventail"]),
  );
});

test("les familles de lyres se dessinent sans erreur", () => {
  const view = new TrackView(analysis());
  const f = frame("refrain", 12);
  for (const family of ["lyres-poursuite", "lyres-duo", "lyres-eventail"] as const) {
    const { ctx } = fakeContext();
    expect(() => drawFamily(ctx, f, view, family)).not.toThrow();
  }
});
```

`drawFamily` est importé depuis `../../src/core/families`.

- [ ] **Step 2: Lancer les tests pour vérifier l'échec**

Run: `bun test tests/unit/concert.test.ts`
Expected: FAIL — les familles n'existent pas dans `CONCERT_FAMILIES` / `FamilyId`.

- [ ] **Step 3: Implémenter les familles**

Dans `concert-rig.ts`, extraire deux fonctions internes :

```ts
function dessinerLyres(ctx: CanvasRenderingContext2D, f: FrameState, view: TrackView, geste: GesteLyre): void
function dessinerBarres(ctx: CanvasRenderingContext2D, f: FrameState, view: TrackView): void
```

`lyresSuspendues` devient `(ctx, f, view) => dessinerLyres(ctx, f, view, "auto")` et `barresLed` `(ctx, f, view) => dessinerBarres(ctx, f, view)` — corps déplacés sans changement.

Ajouter :

```ts
const lyresPoursuite: FamilyDraw = (ctx, f, view) => dessinerLyres(ctx, f, view, "poursuite");
const lyresDuo: FamilyDraw = (ctx, f, view) => {
  dessinerLyres(ctx, f, view, "croisement");
  dessinerBarres(ctx, { ...f, alpha: f.alpha * 0.85 }, view);
};
const lyresEventail: FamilyDraw = (ctx, f, view) => {
  dessinerLyres(ctx, f, view, "eventail");
  dessinerBarres(ctx, { ...f, alpha: f.alpha * 0.85 }, view);
};
```

Et :

```ts
export const CONCERT_FAMILIES = {
  "lyres-suspendues": lyresSuspendues,
  "barres-led": barresLed,
  "pont-concert": pontConcert,
  "lyres-poursuite": lyresPoursuite,
  "lyres-duo": lyresDuo,
  "lyres-eventail": lyresEventail,
} as const;
```

Dans `show.ts`, ajouter les trois identifiants à `FamilyId` et à `FAMILY_LABELS`.

- [ ] **Step 4: Vérifier que les tests passent**

Run: `bun run typecheck && bun test tests/unit/concert.test.ts tests/unit/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/families/concert-rig.ts src/core/show.ts tests/support/fake_canvas.ts tests/unit/render.test.ts tests/unit/concert.test.ts
git commit -m "feat(concert): familles lyres-poursuite, lyres-duo et lyres-eventail"
```

---

### Task 3: Sélection des nouvelles familles dans le plan

**Files:**
- Modify: `src/core/show.ts` (`RHYTHMIC_FAMILIES`, `ENERGETIC_FAMILIES`, `CONCERT_FAMILIES`, branche `refrain` de `familyFor`, ~ligne 621)
- Modify: `docs/scene-effects-spec.md` (§3 et §5)
- Test: `tests/unit/show.test.ts`
- Régénérer: `tests/snapshots/plans/`

**Interfaces:**
- Consumes: `pickFamily(reservoir, seed, turn, excluded, used)`, `FAMILY_BRANCH_RESERVOIRS`.
- Produces: les trois familles sont présentes dans `RHYTHMIC_FAMILIES`, `ENERGETIC_FAMILIES` et `CONCERT_FAMILIES` ; le refrain tire parmi cinq familles.

- [ ] **Step 1: Écrire le test qui échoue**

Dans `tests/unit/show.test.ts` :

```ts
test("les familles de lyres sont tirables et le refrain les atteint", () => {  const caractere = { energy: 0.9, density: 6, brightness: 0.3 };
  const vues = new Set<string>();
  for (let turn = 0; turn < 20; turn += 1) {
    vues.add(familyFor(caractere, false, 7, turn, "refrain"));
  }
  expect(vues.has("lyres-suspendues")).toBe(true);
  expect(vues.has("barres-led")).toBe(true);
  expect([...vues].some((famille) => famille.startsWith("lyres-"))).toBe(true);
  expect(FAMILY_BRANCH_RESERVOIRS.drop).toEqual(
    expect.arrayContaining(["lyres-poursuite", "lyres-duo", "lyres-eventail"]),
  );
  expect(RHYTHMIC_FAMILIES).toEqual(
    expect.arrayContaining(["lyres-poursuite", "lyres-duo", "lyres-eventail"]),
  );
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Importer `familyFor`, `FAMILY_BRANCH_RESERVOIRS` et `RHYTHMIC_FAMILIES` depuis `../../src/core/show`.

Run: `bun test tests/unit/show.test.ts`
Expected: FAIL — le refrain n'alterne qu'entre deux familles / le réservoir drop n'a pas les nouvelles.

- [ ] **Step 3: Implémenter la sélection**

- Ajouter `"lyres-poursuite"`, `"lyres-duo"`, `"lyres-eventail"` aux tableaux `RHYTHMIC_FAMILIES` et `ENERGETIC_FAMILIES`, ainsi qu'à `CONCERT_FAMILIES`.
- Remplacer la branche refrain :

```ts
if (branch === "refrain") {
  return pickFamily(
    ["lyres-suspendues", "barres-led", "lyres-poursuite", "lyres-duo", "lyres-eventail"],
    seed, turn, excluded, used,
  );
}
```

- Mettre à jour `docs/scene-effects-spec.md` : tableau §3 ligne `refrain`, et §5 (familles de concert disponibles).

- [ ] **Step 4: Régénérer les snapshots et lancer les tests**

Run: `bun tools/plan-snapshots.ts --update && bun test tests/unit`
Expected: snapshots réécrits puis PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/show.ts docs/scene-effects-spec.md tests/unit/show.test.ts tests/snapshots/plans
git commit -m "feat(plan): rendre les familles de lyres tirables et enrichir le refrain"
```

---

### Task 4: Module bordure — géométrie et intensité

**Files:**
- Create: `src/core/families/bordure.ts`
- Modify: `src/core/families/index.ts`
- Test: `tests/unit/bordure.test.ts`

**Interfaces:**
- Consumes: `lampHue`, `contrastHue`, `tempsTempsFort`, `clamp01`, `smoothstep`, `hash01`, `activeSlots` ou `count`.
- Produces:
  ```ts
  export const NOMBRE_DIODES_BORDURE = 72;
  export interface DiodeBordure {
    x: number;
    y: number;
    /** Orientation du segment, en radians. */
    angle: number;
    cote: "haut" | "bas" | "gauche" | "droite";
  }
  export function positionBordure(index: number, largeur: number, hauteur: number): DiodeBordure;
  export function intensiteBordure(f: FrameState, view: TrackView, index: number, budgetFlash?: number): number;
  ```

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `tests/unit/bordure.test.ts` avec le générateur `analysis`/`frame` de `concert.test.ts` (recopier, ou importer si exporté). Assertions :

```ts
test("les diodes font le tour du cadre, rentrées du petit côté", () => {
  const largeur = 1280;
  const hauteur = 720;
  const marge = Math.min(largeur, hauteur) * 0.012;
  const points = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, i) =>
    positionBordure(i, largeur, hauteur),
  );
  for (const p of points) {
    expect(p.x).toBeGreaterThanOrEqual(marge - 1e-6);
    expect(p.x).toBeLessThanOrEqual(largeur - marge + 1e-6);
    expect(p.y).toBeGreaterThanOrEqual(marge - 1e-6);
    expect(p.y).toBeLessThanOrEqual(hauteur - marge + 1e-6);
  }
  expect(points[0]!.cote).toBe("haut");
  expect(points.some((p) => p.cote === "bas")).toBe(true);
  expect(points.some((p) => p.cote === "gauche")).toBe(true);
  expect(points.some((p) => p.cote === "droite")).toBe(true);
});

test("la bordure reste éteinte au calme et s'allume sur un impact", () => {
  const view = new TrackView(analysis());
  const calme = frame("couplet", 12, { energy: 0.1, drop: 0, beat: 0 });
  const impact = frame("drop", 12, { energy: 0.95, drop: 1, beat: 1 });
  for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 1) {
    expect(intensiteBordure(calme, view, index)).toBeLessThan(0.1);
  }
  expect(intensiteBordure(impact, view, 0)).toBeGreaterThan(intensiteBordure(calme, view, 0));
});

test("le pourtour tient aussi en portrait", () => {
  const largeur = 400;
  const hauteur = 900;
  const marge = Math.min(largeur, hauteur) * 0.012;
  for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 1) {
    const p = positionBordure(index, largeur, hauteur);
    expect(p.x).toBeGreaterThanOrEqual(marge - 1e-6);
    expect(p.x).toBeLessThanOrEqual(largeur - marge + 1e-6);
    expect(p.y).toBeGreaterThanOrEqual(marge - 1e-6);
    expect(p.y).toBeLessThanOrEqual(hauteur - marge + 1e-6);
  }
});

test("le mode réduit et un budget nul plafonnent la bordure", () => {
  const view = new TrackView(analysis());
  const impact = frame("drop", 12, { energy: 1, drop: 1, beat: 1 });
  expect(intensiteBordure({ ...impact, reduced: true }, view, 0, 1)).toBeLessThanOrEqual(0.31);
  expect(intensiteBordure(impact, view, 0, 0)).toBeLessThanOrEqual(intensiteBordure(impact, view, 0, 1));
});

test("l'intensité est pure et finie", () => {
  const view = new TrackView(analysis());
  const f = frame("refrain", 12, { energy: 0.8 });
  for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 1) {
    const valeur = intensiteBordure(f, view, index);
    expect(Number.isFinite(valeur)).toBe(true);
    expect(valeur).toBeGreaterThanOrEqual(0);
    expect(valeur).toBeLessThanOrEqual(1);
    expect(intensiteBordure(f, view, index)).toBe(valeur);
  }
});
```

- [ ] **Step 2: Lancer les tests pour vérifier l'échec**

Run: `bun test tests/unit/bordure.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter le module**

`positionBordure` : rectangle rentré de `marge = min(largeur, hauteur) * 0.012`. Distribuer `NOMBRE_DIODES_BORDURE` diodes uniformément sur le périmètre (haut gauche → droite → bas → gauche), en partant du milieu du bord haut. Renvoyer l'angle du segment (`0` en haut, `π` en bas, `π/2`/`-π/2` sur les côtés selon le sens).

`intensiteBordure(f, view, index, budgetFlash = 1)` :

```ts
const base = 0.05 + 0.2 * clamp01(f.energy);
const roleGain =
  f.scene.role === "drop" ? 0.55
  : f.scene.role === "refrain" ? 0.25
  : f.scene.role === "montee" ? 0.15 * clamp01(f.build)
  : 0;
const impact = clamp01(f.drop) * 0.4;
const temps = tempsTempsFort(f, view);
const position = ((temps * 0.35) % 1 + 1) % 1;
const positionDiode = index / NOMBRE_DIODES_BORDURE;
const distance = Math.min(Math.abs(positionDiode - position), 1 - Math.abs(positionDiode - position));
const chenillard =
  smoothstep(0.35, 0.7, clamp01(f.energy)) *
  (0.18 + 0.5 * clamp01(f.energy)) *
  (1 - smoothstep(0.015, 0.09, distance));
const eclat = clamp01(f.drop) * clamp01(budgetFlash) * 0.5;
const brut = base + roleGain + impact + chenillard + eclat;
return f.reduced ? Math.min(0.3, brut * 0.5) : clamp01(brut);
```

Ajouter `couleurBordure(f, index)` (via `lampHue`) pour la tâche 5.

- [ ] **Step 4: Vérifier que les tests passent**

Run: `bun test tests/unit/bordure.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/families/bordure.ts src/core/families/index.ts tests/unit/bordure.test.ts
git commit -m "feat(bordure): géométrie du pourtour et intensité analytique des diodes"
```

---

### Task 5: Dessin de la bordure et intégration permanente

**Files:**
- Modify: `src/core/families/bordure.ts` (`dessinerBordure`)
- Modify: `src/core/families/index.ts`
- Modify: `src/core/render.ts` (import + appel après `dessinerBlinders`, ~ligne 829)
- Test: `tests/unit/bordure.test.ts`
- Modify: `docs/scene-effects-spec.md` (nouvelle section bordure)

**Interfaces:**
- Consumes: `positionBordure`, `intensiteBordure`, `couleurBordure`, `paint`.
- Produces: `export function dessinerBordure(ctx: CanvasRenderingContext2D, f: FrameState, view: TrackView, budgetFlash?: number): void`.

- [ ] **Step 1: Écrire le test qui échoue**

Dans `tests/unit/bordure.test.ts`, avec un faux contexte local (même forme que `fakeContext` de `render.test.ts`) :

```ts
test("dessinerBordure dépose des diodes et reste pure", () => {
  const view = new TrackView(analysis());
  const f = frame("drop", 12, { energy: 1, drop: 1, beat: 1 });
  const premier = fakeContext();
  dessinerBordure(premier.ctx, f, view, 1);
  const second = fakeContext();
  dessinerBordure(second.ctx, f, view, 1);
  expect(premier.operations.filter((op) => op === "fill").length).toBeGreaterThan(0);
  expect(second.operations).toEqual(premier.operations);
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `bun test tests/unit/bordure.test.ts`
Expected: FAIL — `dessinerBordure` n'existe pas.

- [ ] **Step 3: Implémenter le dessin et l'appel**

`dessinerBordure` :

- Tracer d'abord le rail continu (une ligne fermée le long du rectangle rentré) en trait fin et semi-transparent, avec la teinte `contrastHue(f)`.
- Pour chaque diode : `intensite = intensiteBordure(...)` ; si `<= 0.01`, passer. Cœur : petit cercle/rect de rayon `max(1, min(w,h) * 0.0016)` à `paint(couleur, 0.9, 0.9, intensite)`. Halo : second cercle de rayon `× 3` à alpha `intensite * 0.25`, sans gradient par diode.
- Aucune transformation de contexte (`save`/`translate`/`scale`), pour rester compatible avec le faux contexte des tests.

Dans `render.ts` :

```ts
import { dessinerBordure, ... } from "./families";
// après dessinerBlinders :
dessinerBordure(ctx, permanent, view, settings.flashes);
```

Mettre à jour `docs/scene-effects-spec.md` avec une section « Bordure LED » : géométrie, déclencheurs, plafond du mode réduit, budget de flash.

- [ ] **Step 4: Vérifier types, lint et tests**

Run: `bun run typecheck && bun run lint && bun test tests/unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/families/bordure.ts src/core/families/index.ts src/core/render.ts docs/scene-effects-spec.md tests/unit/bordure.test.ts
git commit -m "feat(render): bordure LED permanente autour de l'écran"
```

---

## Vérification finale

- [ ] `bun run check` (types, lint, tests front + serveur)
- [ ] `bun tools/plan-snapshots.ts` (vérification, pas de diff)
- [ ] Vérification visuelle : `bun run dev`, lancer un morceau avec un drop ; contrôler les trois familles et la bordure, puis repasser en mode réduit.
