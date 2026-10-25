# Tester

## Installation et suite complète

```bash
bun install                 # précondition : sans node_modules, tsc échoue (TS2688)
uv sync                     # environnement Python (pytest, librosa, ruff)
bun run check               # install + typecheck + lint + tests, arrêt au premier échec
```

`bun run test` exécute les trois étapes et agrège les échecs :

```bash
bun run typecheck           # tsc --noEmit
bun run test                # types + tests front (bun test) + tests serveur (pytest)
bun run lint                # oxlint + ruff
```

La mesure de référence (nombre de tests, durée, versions) est dans
[`baseline.md`](baseline.md).

## Tests front et serveur

- Front : `tests/unit/*.test.ts` (cœur pur, rendu, plan, contrats).
- Serveur : `tests/unit/test_*.py` (analyse, API, robustesse).
- Navigateur : `tests/e2e/*.mjs`, à lancer séparément (`bun run check:browser`,
  `check:sync`, etc.) — ils exigent Playwright et un build.

Les tests marqués `test.failing` documentent un bug de production **connu** :
ils réussissent tant que le bug est là et échouent dès qu'il est corrigé (il
faut alors retirer le marqueur). Chacun référence le `fichier:ligne` fautif et
la valeur mesurée. La liste courante (et la justification de chaque écart
assumé) est dans la section 8 de
[`integration-report.md`](integration-report.md) ; le rapport
[`test-harness-report.md`](test-harness-report.md) est l'instantané de la tâche
D0–D9 et ne doit plus servir de référence.

## Corpus de référence

Le corpus n'est **pas committé**. Il est régénéré en moins de 10 s, à
l'identique (même hash SHA-256), par :

```bash
uv run python tests/support/make_fixture.py corpus tests/fixtures/corpus
```

Dix pistes couvrent : aigus denses, basses seules, voix médiane, trois drops,
aucune montée, silence au milieu, durée courte, tempo douteux, niveau -40 dBFS,
niveau saturé. Le manifeste `manifest.json` décrit ce que chaque piste doit
provoquer. Les tests de propriété consomment des analyses **réelles** de ce
corpus (cache dans `tests/fixtures/analyses/`, régénéré automatiquement).

## Harnais de métriques

Point d'entrée unique pour comparer avant/après avec les mêmes chiffres :

```bash
bun run measure --label baseline
bun run measure --label A
bun run compare-metrics docs/metrics/baseline.json docs/metrics/A.json
```

Le JSON contient trois blocs par piste : `plan`, `render`, `timing`. Tous les
champs sont décrits dans [`metrics/README.md`](metrics/README.md). Le JSON est
stable à l'octet près hors `timing` : une deuxième exécution doit produire le
même objet (comparer avec un diff en retirant `timing`).

### Lire `compare-metrics`

```
métrique                        baseline   A          écart    ▲/▼/=
part famille dominante          39.2 %     24.1 %     -15.1 %  ▲
dérive max depuis la scène      50.5°      62.0°      +11.5°   ▼
```

- `▲` : amélioration ; `▼` : dégradation ; `=` : sous le seuil ; `◆` :
  changement neutre (cadence de flashs, nombre de scènes — données de DA).
- Seuils documentés en tête de `scripts/compare-metrics.ts` : 0,5 point pour
  les parts, 1° pour les teintes, 0,5 pour les compteurs, 2 % en relatif sinon.
- Les valeurs affichées sont des **moyennes sur le corpus**. Pour un détail par
  piste, ouvrir les deux JSON et comparer `tracks.<nom>`.

## Goldens visuels

Non activés : l'environnement n'a **pas** de toile native (`node-canvas`,
skia) et le projet refuse d'ajouter une dépendance lourde pour ça. La procédure,
si une toile devient disponible :

1. ajouter un rendu hors écran 320×180 (mêmes appels que `renderFrame`) ;
2. comparer les pixels à une référence PNG versionnée, tolérance 2 % de pixels
   et delta de couleur borné ;
3. mettre à jour explicitement via `bun run golden:update`, jamais
   automatiquement ;
4. garder l'ensemble des références sous 2 Mo ;
5. ne lancer ces tests que si `GOLDEN=1` (les changements esthétiques volontaires
   ne doivent pas bloquer la CI).

Aucun fichier `tests/golden/` n'est créé tant que ces conditions ne sont pas
réunies.

## Outillage manuel (hors CI)

Trois scripts servent à instrumenter à la main ; aucun ne tourne en CI.

| script | usage |
| --- | --- |
| `uv run python bench/bench_analysis.py <fichier>` | chronomètre chaque étape de l'analyse librosa (chargement, onset, beat_track, STFT, analyse complète) et affiche tempo, sections, montées |
| `uv run python scripts/analyze_corpus.py --corpus tests/fixtures/corpus --out /tmp/analyses.json` | analyse tout le corpus dans un JSON au contrat du front (`measure.ts` l'appelle lui-même sur un fichier temporaire) |
| `uv run python scripts/bench_chronology.py <fichier…>` | mesure la chronologie réelle résolution + analyse (cache audio et cache d'analyse compris), sans dépendre de Deezer |

`bench/` ne fait pas partie de la suite de tests : c'est un profileur ponctuel,
à lancer sur un fichier précis quand une analyse paraît lente.
