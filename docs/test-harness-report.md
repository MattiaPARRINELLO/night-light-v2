# Rapport — filet de sécurité commun (tâches D0 à D9)

Worktree `chore/test-harness-baseline`, base `6bf8d2c`. Aucun fichier interdit
n'a été modifié : `git diff --stat 6bf8d2c -- src/core/{show,view,render,harmony}.ts
src/core/families` est vide (vérifié en fin de parcours).

## 1. Avancement

| tâche | statut | pourquoi |
| --- | --- | --- |
| **D0** environnement reproductible | fait | `bun install`, baseline chiffrée, `scripts/check.sh`, `docs/baseline.md` |
| **D1** corpus réaliste | fait | 10 pistes déterministes + manifeste, régénération < 2 s, hash stable |
| **D2** harnais de métriques | fait | `scripts/measure.ts`, `scripts/compare-metrics.ts`, `docs/metrics/baseline.json` **commité en premier**, reproductible hors temps |
| **D3** robustesse entrées dégénérées | fait | tests Python (durées, formats, silence, NaN/inf) + tests TS (plan + 5 images). Gardes serveur ajoutées : tempo non fini, courbes NaN/inf |
| **D4** propriétés du plan | fait | P1–P10 ; 2 échecs attendus (P7, P9) |
| **D5** propriétés du rendu | fait | R1–R7 + F1–F3 ; 2 échecs attendus (R6, F2) |
| **D6** contrats croisés | fait | X1–X4 ; 4 échecs attendus (tous documentés) |
| **D7** goldens visuels | ignoré | pas de toile native (`node-canvas`/skia) et refus d'ajouter une dépendance lourde. Procédure documentée dans `docs/testing.md` |
| **D8** documentation | fait | `docs/scene-effects-spec.md` (statut + preuve), `docs/testing.md`, README corrigé et marqueurs de fusion |
| **D9** CI et lint | fait | CI existante : lint + typecheck + tests après `uv sync`, caches bun/uv |

## 2. Suite de tests avant / après

| étape | avant (D0) | après |
| --- | --- | --- |
| tests front | 192 passés, 2,83 s | **329 passés** (dont 8 `test.failing` attendus), 1,58 s |
| tests serveur | 149 passés, 74,52 s | **168 passés**, 47,90 s |
| total | 341 | **497** |
| typecheck | OK | OK |
| lint | OK | OK |

Commande : `bun run test`. Les `test.failing` comptent comme « passés » tant que
le bug est présent ; Bun échoue si l'un d'eux se met à passer (le marqueur doit
alors être retiré).

## 3. Tests en échec attendu (bugs de production documentés)

| propriété | test | `fichier:ligne` fautif | mesure observée | agent |
| --- | --- | --- | --- | --- |
| **P7** deux graines changent ≥ 30 % des familles | `tests/unit/plan-properties.test.ts` | `src/core/show.ts:579` + `349` : `Math.floor(turn + hash01(...) × 0,9)` annule la fraction | **0 %** de familles différentes (graines 1 vs 2) sur les 10 pistes | A |
| **P9** écart de teinte ≥ 34° entre scènes voisines | idem | `src/core/show.ts:611-620` : le clamp ±spread s'applique APRÈS `MIN_HUE_STEP` | **28,0°** (`e_sans_montee`, 0 s → 8,081 s) | A |
| **R6** écart de teinte < 8° hors événement | `tests/unit/render-properties.test.ts` | `src/core/render.ts:350-361` (+ `show.ts:599-620` pour l'ancre) | pire : **176,8°** (`d_trois_drops`, 15,1 s) ; 12,2° à 178,9° selon les pistes | B (et A pour le changement d'ancre) |
| **F2** flash de drop ≥ 2 × flash ordinaire | idem | `src/core/render.ts:145-155` : `dropHit` ne dépasse pas toujours `beatHit` | **0,69×** (`b_basses_seules`), **1,52×** (`e_sans_montee`), **0,87×** (`f_silence_milieu`) | B |
| **X1** budget de teinte sur 10 min | `tests/unit/contracts.test.ts` | `src/core/render.ts:351-353` : dérive `0,4 × t` non bornée | pire : **115,0°** pour un budget de **90,0°** (`b_basses_seules`, 236,7 s) ; dépassé sur les 10 pistes | B |
| **X2** tout champ de `Scene` est consommé | idem | `src/core/show.ts:64-65`, `130` : `backdrop` et `reason` ne sont lus par personne | champs morts : **`backdrop`, `reason`** | A (plan) / B (rendu) |
| **X3** chaque famille du registre est atteignable | idem | `src/core/show.ts:182-237` (réservoirs) + `340-369` | **20 familles sur 29** jamais choisies : `grid, shutters, bars, parade, crossfire, curtain, burst, gobos, pendule, couronne, pluie, portique, etoile, vortex, lyre, mandala, treillis, rideaux, lyres-suspendues, barres-led` | A |
| **X4** aucune branche morte de `moodFor`/`roleFor`/`familyFor` | idem | `src/core/show.ts:352-368`, `379-390`, `420-430` + `server/analysis.py:370-398` | morts — humeurs : `silence`, `montée`, défaut `pulse` ; rôles : `kind intro/refrain/couplet/outro/pont`, `label montée`, `label descente/silence` ; familles : `rôle refrain`, `rôle montée`, `énergie < 0,22`, `densité > 2,2`, `énergie > 0,6`, défaut | A |

## 4. Autres bugs / constats non corrigés

- **Saturation de la brillance** : `caractereAt` initialise `brightness` à 0,5
  (`src/core/show.ts:292`) et l'additionne ; **98,3 %** des scènes du corpus
  dépassent 0,62. La branche « brillance > 0,62 » de `familyFor` est donc la
  branche quasi unique — c'est la cause probable de la faible diversité (X3) et
  de l'humeur `pulse` inatteignable (X4). Agent A.
- **Piste « 3 drops »** : le générateur contient bien trois montées musicales,
  mais `analyze_file` n'en détecte qu'une (`buildCount = 1`). Ce n'est pas un
  crash ; c'est consigné ici pour que le calibrage des montées soit revu
  humainement (hors périmètre : formules d'énergie).
- **README** : plusieurs affirmations restent dépendantes des corrections A/B et
  sont marquées (voir §6). Les chiffres déjà faux ont été corrigés (familles
  29 et non 28, espacement des flashs, saut de drop 26°, wash 6,5 s, étiquettes de
  section réellement produites).
- **`plan.backdrop`** est documenté dans le README comme la couche de fond
  permanente ; le rendu ne le lit jamais. Marqué `CODE MORT`.

## 5. Métriques de baseline (extrait de `docs/metrics/baseline.json`)

| piste | scènes | familles | dominante | bright > 0,62 | flashs/min | Δteinte hors évt | dérive | fond min |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a_aigus_denses | 4 | 4 | 25 % | 100 % | 18,0 | 178,9° | 51,7° | 0,067 |
| b_basses_seules | 4 | 4 | 25 % | 100 % | 18,0 | 158,6° | 51,8° | 0,067 |
| c_voix_mediane | 3 | 3 | 33 % | 100 % | 10,0 | 153,2° | 52,0° | 0,067 |
| d_trois_drops | 6 | 6 | 17 % | 100 % | 2,7 | 166,4° | 51,8° | 0,067 |
| e_sans_montee | 4 | 4 | 25 % | 100 % | 30,0 | 131,1° | 51,7° | 0,067 |
| f_silence_milieu | 6 | 6 | 17 % | 83 % | 25,5 | 89,8° | 52,1° | 0,067 |
| g_court | 1 | 1 | 100 % | 100 % | 30,0 | 12,2° | 37,1° | 0,067 |
| h_tempo_douteux | 2 | 2 | 50 % | 100 % | 15,0 | 154,0° | 52,2° | 0,067 |
| i1_tres_faible | 2 | 2 | 50 % | 100 % | 30,0 | 52,7° | 52,2° | 0,067 |
| i2_sature | 2 | 2 | 50 % | 100 % | 24,0 | 52,6° | 52,2° | 0,067 |

Agrégats : 3,4 scènes/morceau, part dominante moyenne 39,2 %, brillance
saturée 98,3 %, 20,3 flashs/min, dérive moyenne 50,5°, **0 image sous le
plancher visible**. Coût du rendu mesuré : médiane ≈ 0,11 ms/image, p95
≈ 0,37 ms (contexte factice, sans rasterisation).

## 6. Marqueurs « À METTRE À JOUR APRÈS FUSION »

Ces marqueurs ont été **traités par l'intégration** (branche `fix/integration`) :

- les cinq marqueurs du `README.md` ont été retirés et le texte mis à jour
  (tirage par graine, couche permanente réelle, dérive bornée, brillance en
  moyenne, signature de drop, latence/montée des flashs) ;
- le document d'audit de C est conservé sous `docs/scene-effects-audit.md` avec
  ses marqueurs renommés « ÉTAT AVANT FUSION » ;
- la spécification à jour est `docs/scene-effects-spec.md` (PR #30).

## 7. Hypothèses et hésitations

- **« alpha du fond »** : le fond dessiné par `drawBackground` est **opaque**
  (alpha 1). Mesurer son alpha ne dirait rien d'un écran noir. Le harnais mesure
  donc la luminosité HSL des deux arrêts du dégradé, avec les expressions
  exactes du rendu (`render.ts:91-96`). C'est documenté dans
  `docs/metrics/README.md`.
- **Vocabulaire « flare / prisme / variation / wash »** : aucune famille de ce
  nom n'existe. En mode réduit, les éléments interdits testés (P10) sont les
  familles de concert/rythmiques et, côté rendu, flash/wash/variation.
- **P4 « N scènes avant retour d'une famille »** : aucun `N` n'existe dans
  `show.ts`. Le test vérifie le seul invariant voisin réel (N = 2) et le
  documente.
- **P2 durée maxi de scène** : aucun maximum n'est documenté dans le code ; seul
  le plancher de 5 s est testé.
- **P8 sur 3 minutes** : piste longue générée par `write_rich_track(180)` et
  analysée réellement, pas une analyse fabriquée.
- **Corpus** : jamais committé (`.gitignore`), régénéré en < 2 s avec hash
  stable. Les tests de propriété consomment de vraies analyses, mises en cache
  dans `tests/fixtures/analyses/` (ignoré).
- **CI** : la tâche D9 exigeait l'enchaînement install → lint → typecheck →
  test sur runner propre. L'ordre a été corrigé pour faire `uv sync` **avant**
  les tests front, car les tests de propriété appellent `uv run python
  scripts/analyze_corpus.py`.
- **Aucune dépendance ajoutée** (R4) : le harnais utilise Bun, Node et les
  outils déjà présents.

## 8. Commandes de vérification

```bash
bun install && uv sync
bun run check                       # arrêt au premier échec
bun run measure --label baseline
bun run compare-metrics docs/metrics/baseline.json docs/metrics/A.json
```
