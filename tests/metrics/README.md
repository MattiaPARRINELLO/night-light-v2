# Instruments de mesure du plan et du rendu

Ces outils ne modifient **aucun** comportement du produit. Ils lisent
`buildShowPlan`, `renderFrame` et les analyses du corpus. Tout est déterministe
et rejouable.

## Corpus

Deux sources :

- `tests/support/make_corpus.py` (six pistes de 60 s : 60, 90, 128, 170 BPM,
  128 BPM faible niveau, piste « riche »). Généré au premier lancement dans
  `/tmp/night-light-plan-corpus`, puis réutilisé. C'est le corpus des snapshots
  et du rapport « avant ».
- morceaux réels, **optionnels**, via `--real <fichier|répertoire>` (ou
  `NIGHTLIGHT_REAL_CORPUS=/chemin1:/chemin2`). Leur audio n'étant pas dans le
  dépôt, ils ne sont jamais inclus dans les snapshots versionnés.

## Snapshots de plans

```bash
bun tools/plan-snapshots.ts            # vérifie, code retour 1 si diff
bun tools/plan-snapshots.ts --update   # réécrit EXPLICITEMENT les snapshots
```

Fichiers : `tests/snapshots/plans/corpus.json` (plan normal) et
`corpus-reduced.json` (mode confort). Clés triées, flottants arrondis à
3 décimales. Champs par scène : `start, end, reason, role, mood, family,
variant, backdrop, hue, accent, intensity, fadeIn, fadeOut, saturation,
lightness, drop`.

La mise à jour n'est jamais automatique. Tout diff doit être justifié scène par
scène ou par catégorie dans la revue.

## Rapport de distribution

```bash
bun tools/plan-report.ts --json tests/metrics/plan-report.json
bun tools/plan-report.ts --diff ancien.json nouveau.json
```

Sortie : rôles, humeurs, familles, raisons de frontière, branches de
`familyFor` / `moodFor`, durées de scène (min, p10, p25, médiane, p75, p90,
max), drops par morceau, distributions brutes énergie / densité / brillance,
branches mortes, incohérences humeur ↔ réservoir, et diff entre deux rapports.
Percentiles par interpolation linéaire.

## Timeline visuelle

```bash
bun tools/plan-timeline.ts rich --out /tmp/rich.html
bun tools/plan-timeline.ts --all        # une page par piste dans tests/metrics/timelines/
```

HTML statique autonome : aucune requête réseau, aucun script. Courbe d'énergie,
montées, drops, bandes de scène colorées par teinte avec rôle / humeur / famille
/ raison, tableau détaillé.

## Pureté du rendu

`tests/unit/render-purity.test.ts` rend en continu `0 → t`, puis `t` seul
après seek, sur trois morceaux, dans Chromium headless (vrai canvas), et exige
**0 pixel différent, delta 0**, sans préchauffage.

Sans remise à zéro du contexte entre deux images, Chromium conserve un cache de
rastérisation interne au canvas : l'image à `t` diffère alors de 1 à 4 niveaux
(146 px / 57 600, 0,25 %, uniquement des pixels sombres) selon que le canvas
vient de rendre un instant voisin. Le harnais appelle `ctx.reset()` avant chaque
image pour neutraliser ce cache moteur ; ce n'est ni une tolérance ni un
préchauffage, et aucun état applicatif ne subsiste entre deux images (vérifié
par une remise à zéro du contexte avant comparaison). La production, elle, ne
fait pas ce reset : un seek dans l'application peut donc conserver ce résidu
moteur de 1 à 4 niveaux, invisible à l'œil.

La vignette (`vignetteFor`) a été mesurée dans les deux variantes : recréer le
dégradé à chaque image ne supprime pas ce résidu et coûte +1,0 ms/image en
320×180 (2,48 vs 1,49 ms) et +1,1 ms en 1280×720 (11,10 vs 9,96 ms). Le cache
`WeakMap` par contexte est donc conservé.

## Saturation des drops

```bash
bun tools/saturation-report.ts --out tests/metrics/saturation.json
```

Part de pixels proches du blanc : luminance Rec. 709 > 0,92 **et** saturation
HSV < 0,15. Échantillonnage à 10 Hz sur chaque scène de rôle `drop`, image
réelle 320×180. Sert de juge à la vague 2.

## Dette d'instrumentation

`src/core/show.ts` n'exporte pas `familyFor`, `moodFor`, ni
`MOOD_BRIGHTNESS_THRESHOLD`, ni les réservoirs `CALM_FAMILIES`,
`RHYTHMIC_FAMILIES`, `ENERGETIC_FAMILIES`. `tests/support/plan_report.ts` les
recopie, avec un commentaire explicite. Toute évolution de ces fonctions doit
être répercutée ici, sinon le rapport mentira sur les branches.

## Corpus réel et baseline

```bash
uv run python tools/real_corpus.py     # télécharge les manquants + analyse (idempotent)
bun tools/baseline-report.ts           # tools/baseline-report.md + .json
```

Le manifeste `tests/support/real_corpus.json` porte les 10 morceaux réels
(`id` Deezer, titre, artiste, profil, durée). Le téléchargement réutilise
l'outil Deezer du projet (`server.retrieve`) et le cache audio du serveur ; un
morceau déjà présent n'est pas retéléchargé. Le cookie n'est jamais écrit ni
affiché : il est lu depuis `DEEZER_ARL` ou la configuration streamrip en cache.

Les fichiers audio et les analyses réelles restent dans
`tests/fixtures/analyses/` (ignoré par git). Seuls le manifeste et les deux
rapports `tools/baseline-report.*` sont versionnés. La baseline est
reproductible au SHA-256 près (`1c315fa2…` mesuré sur cette machine) ; elle n'est
pas un test de CI et n'entre pas dans les snapshots.
