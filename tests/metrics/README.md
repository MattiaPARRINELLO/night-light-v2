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
après seek, sur trois morceaux, dans Chromium headless (vrai canvas). Deux
mesures :

- à froid (premier rendu d'un canvas) : tolérance canvas documentée de **0,5 %
  des pixels et 4 niveaux** (mesuré : 0,26 % / 4 niveaux, fond sombre). Artefact
  du cache de dégradés de Skia, pas un état accumulé ;
- après chauffe identique des deux canvas : **0 pixel différent**, contrat strict.

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
