# Métriques du harnais

## Produire une mesure

```bash
bun scripts/measure.ts --label baseline
bun scripts/measure.ts --label A
bun scripts/measure.ts --label B
bun scripts/measure.ts --label fusion
```

`--label` écrit `docs/metrics/<label>.json`. On peut aussi donner un chemin
explicite : `--out docs/metrics/mon-essai.json`.

Le script :

1. régénère le corpus s'il manque (`tests/support/make_fixture.py corpus`) ;
2. analyse chaque piste avec le VRAI `analyze_file` (via
   `scripts/analyze_corpus.py`) ;
3. construit le plan avec `buildShowPlan` ;
4. échantillonne le rendu à 30 images/s avec `renderFrame` sur un contexte
   factice (mêmes chemins de code, sans rasterisation) ;
5. écrit un JSON à clés triées.

Le JSON est reproductible à l'octet près **hors section `timing`** (temps de
calcul et mémoire). C'est vérifié : deux exécutions successives donnent le même
objet une fois `timing` retiré.

## Comparer deux mesures

```bash
bun scripts/compare-metrics.ts docs/metrics/baseline.json docs/metrics/A.json
```

Légende : `▲` amélioré, `▼` dégradé, `=` stable, `◆` changement neutre (donnée
de direction artistique, pas un critère de qualité). Les seuils sont documentés
en tête de `scripts/compare-metrics.ts` : 0,5 point pour les parts, 1° pour les
teintes, 0,5 pour les compteurs, 2 % en relatif sinon.

## Lire les champs

| chemin | sens |
| --- | --- |
| `tracks.<piste>.analysis` | durée, tempo, nombre de temps/onsets/montées |
| `tracks.<piste>.plan.sceneCount` | nombre de scènes |
| `plan.familyHistogram` | histogramme des familles |
| `plan.topFamilyShare` | part de la famille la plus fréquente |
| `plan.brightSceneShare` | part de scènes où `brightness > 0,62` (saturation) |
| `plan.adjacentHueGapMinDeg` | plus petit écart de teinte entre scènes voisines |
| `plan.hueWindowDeg` | amplitude de teinte utilisée sur le morceau |
| `render.maxHueDeltaDeg` | plus grand saut de teinte image à image |
| `render.maxHueDeltaOutsideEventDeg` | idem, hors drop/variation |
| `render.maxDriftFromSceneHueDeg` | dérive max depuis la teinte de la scène |
| `render.flashesPerMinute` | cadence mesurée, sans plafond (donnée de DA) |
| `render.dropFlashAlphaMedian` | alpha médian des flashs de drop |
| `render.ordinaryFlashAlphaMedian` | alpha médian des flashs ordinaires |
| `render.backgroundLightnessMin` | luminosité minimale du fond (écran noir) |
| `render.rawEnergyBelowFloorShare` | part d'images sous le plancher d'énergie brute |
| `render.visibleEnergyBelowFloorShare` | idem sur l'énergie visible (doit rester 0) |
| `timing.medianMs` / `p95Ms` | coût du rendu par image |
| `timing.peakMemoryBytes` | croissance de RSS observée pendant la piste |

### Note sur « alpha du fond »

`drawBackground` (`src/core/render.ts:95-96`) peint un fond **opaque** : son
alpha vaut toujours 1, il ne peut donc pas révéler un écran noir. Le harnais
mesure à la place la **luminosité HSL** des deux arrêts du dégradé, calculée
avec les mêmes expressions que le rendu. C'est la métrique `backgroundLightness*`.
