# Baseline — plan de spectacle, synthétique vs réel

Photo de référence générée par `bun tools/baseline-report.ts`. Aucun horodatage : le fichier est reproductible au SHA-256 près.

## Corpus

- **Synthétique** : 6 pistes, 43 scènes (make_corpus.py).
- **Réel** : 10 pistes, 520 scènes (manifeste `tests/support/real_corpus.json`).

## 1. Distributions des caractères par scène

| caractère | min | p10 | médiane | p75 | p90 | max | moyenne |
| --- | --- | --- | --- | --- | --- | --- | --- |
| énergie (synthétique) | 0.170 | 0.197 | 0.722 | 0.837 | 0.857 | 0.891 | 0.575 |
| énergie (réel) | 0.050 | 0.093 | 0.704 | 0.852 | 0.913 | 0.969 | 0.619 |
| densité (synthétique) | 0.065 | 2.389 | 5.067 | 5.246 | 6.372 | 6.608 | 4.432 |
| densité (réel) | 0.000 | 0.187 | 2.409 | 3.464 | 4.520 | 8.180 | 2.479 |
| brillance (synthétique) | 0.000 | 0.045 | 0.188 | 0.267 | 0.310 | 0.710 | 0.184 |
| brillance (réel) | 0.000 | 0.000 | 0.204 | 0.405 | 0.608 | 0.903 | 0.249 |

**Bimodalité de l'énergie** — scènes dans ]0.55 ; 0.68[ : synthétique 0/43 (0.0 %), réel 79/520 (15.2 %).
Répartition : synthétique 19 ≤ 0.55 / 24 ≥ 0.68 ; réel 168 / 273.

## 2. Frontières et humeurs

| mesure | synthétique | réel |
| --- | --- | --- |
| frontières `cycle` | 74.4 % | 83.8 % |
| humeur `explosif` | 55.8 % | 66.2 % |
| familles distinctes | 20 | 29 |

### Familles mortes

- **Synthétique** (9) : barres-led (barres LED), bars (barres), couronne (couronne), curtain (rideau de lumière), etoile (étoile), grid (grille), lyres-suspendues (lyres suspendues), mandala (rosace), shutters (volets)
- **Réel** : aucune

### Autres branches mortes

- **Rôles (synthétique)** (2) : montee (montée), refrain (refrain)
- **Rôles (réel)** (2) : montee (montée), refrain (refrain)
- **Humeurs (synthétique)** (1) : sombre (sombre)
- **Humeurs (réel)** (1) : sombre (sombre)
- **Raisons (synthétique)** (3) : beat (nouvelle mesure), finale (fin du morceau), section (nouveau passage)
- **Raisons (réel)** (3) : beat (nouvelle mesure), finale (fin du morceau), section (nouveau passage)
- **familyFor (synthétique)** (2) : montee, refrain
- **familyFor (réel)** (2) : montee, refrain
- **moodFor (synthétique)** (3) : montee-pulse, refrain-explosif, silence-sombre
- **moodFor (réel)** (3) : montee-pulse, refrain-explosif, silence-sombre

## 3. Drops par morceau

| corpus | morceau | profil | drops |
| --- | --- | --- | --- |
| synthétique | 128bpm-low | — | 1 |
| synthétique | 128bpm | — | 1 |
| synthétique | 170bpm | — | 1 |
| synthétique | 60bpm | — | 1 |
| synthétique | 90bpm | — | 0 |
| synthétique | rich | — | 1 |
| réel | One More Time | électro à drops marqués | 5 |
| réel | Bolero | très dynamique (classique) | 8 |
| réel | They Don't Care About Us | pop couplet/refrain classique | 7 |
| réel | The Blue Danube, Op. 314 | morceau en 3/4 | 12 |
| réel | La Vie en Rose | valse / 3/4 chanté | 7 |
| réel | Gymnopédie No. 1 | acoustique calme | 10 |
| réel | Latch | house linéaire | 5 |
| réel | Your Hand in Mine | très dynamique (post-rock) | 7 |
| réel | Shine On You Crazy Diamond (Pts. 1-5) | longue intro (> 45 s) | 12 |
| réel | TRINITYVILLE | rap masterisé sans montée | 2 |

### Morceaux réels sans aucun drop

Aucun : toutes les pistes réelles déclenchent au moins un impact.

## 4. Métrique (corpus réel)

Attendu : 4 morceau(x) en 3/4, 6 en 4/4. Détecté : 4 en 3/4, 6 en 4/4. **4/10 concordent.**

| morceau | attendu | détecté |
| --- | --- | --- |
| Bolero | 3/4 | 4/4 |
| La Vie en Rose | 3/4 | 4/4 |
| Gymnopédie No. 1 | 3/4 | 4/4 |
| Latch | 4/4 | 3/4 |
| Your Hand in Mine | 4/4 | 3/4 |
| Shine On You Crazy Diamond (Pts. 1-5) | 4/4 | 3/4 |

## 5. Saturation des drops (corpus réel)

Échantillonnage 10 Hz, 320×180, luminance > 0.92 et saturation < 0.15. **75 drops, 6942 échantillons** ; moyenne 0.40 %, p90 0.31 %, max 29.48 % (Your Hand in Mine à 377.88 s).

| morceau | début | fin | n | moyenne | p90 | max | max à |
| --- | --- | --- | --- | --- | --- | --- | --- |
| One More Time | 30.44 s | 39.22 s | 88 | 0.34 % | 0.06 % | 28.25 % | 30.54 s |
| One More Time | 45.95 s | 54.85 s | 89 | 0.85 % | 0.78 % | 28.91 % | 46.05 s |
| One More Time | 166.44 s | 174.94 s | 85 | 0.42 % | 0.00 % | 27.97 % | 166.54 s |
| One More Time | 174.94 s | 186.46 s | 116 | 0.17 % | 0.07 % | 17.50 % | 175.04 s |
| One More Time | 244.40 s | 256.51 s | 122 | 0.39 % | 0.24 % | 29.07 % | 244.50 s |
| Bolero | 10.17 s | 21.94 s | 118 | 0.09 % | 0.00 % | 10.85 % | 10.27 s |
| Bolero | 47.79 s | 54.52 s | 68 | 0.39 % | 0.00 % | 22.14 % | 47.89 s |
| Bolero | 54.52 s | 65.62 s | 111 | 0.29 % | 0.09 % | 28.91 % | 54.62 s |
| Bolero | 80.34 s | 92.07 s | 118 | 0.28 % | 0.07 % | 28.70 % | 80.44 s |
| Bolero | 92.07 s | 103.82 s | 118 | 0.29 % | 0.00 % | 22.80 % | 92.17 s |
| Bolero | 103.82 s | 109.20 s | 54 | 0.54 % | 0.20 % | 26.32 % | 103.92 s |
| Bolero | 126.85 s | 138.11 s | 113 | 0.22 % | 0.00 % | 24.10 % | 126.95 s |
| Bolero | 223.68 s | 231.20 s | 76 | 0.87 % | 0.08 % | 28.96 % | 223.78 s |
| They Don't Care About Us | 12.79 s | 21.48 s | 87 | 0.37 % | 0.08 % | 29.10 % | 12.89 s |
| They Don't Care About Us | 21.48 s | 32.69 s | 113 | 0.61 % | 0.04 % | 28.91 % | 21.58 s |
| They Don't Care About Us | 65.88 s | 74.67 s | 88 | 0.30 % | 0.08 % | 24.13 % | 65.97 s |
| They Don't Care About Us | 74.67 s | 81.85 s | 72 | 1.10 % | 0.78 % | 29.34 % | 74.78 s |
| They Don't Care About Us | 100.52 s | 106.49 s | 60 | 0.60 % | 0.28 % | 26.54 % | 100.62 s |
| They Don't Care About Us | 111.83 s | 122.53 s | 108 | 0.66 % | 0.27 % | 27.30 % | 111.93 s |
| They Don't Care About Us | 167.18 s | 179.00 s | 119 | 0.38 % | 0.22 % | 28.02 % | 167.28 s |
| The Blue Danube, Op. 314 | 14.10 s | 25.95 s | 119 | 0.00 % | 0.00 % | 0.00 % | 14.10 s |
| The Blue Danube, Op. 314 | 25.95 s | 36.43 s | 105 | 0.26 % | 0.04 % | 22.87 % | 26.05 s |
| The Blue Danube, Op. 314 | 64.45 s | 72.26 s | 79 | 0.17 % | 0.09 % | 11.99 % | 64.55 s |
| The Blue Danube, Op. 314 | 80.95 s | 86.65 s | 57 | 0.00 % | 0.00 % | 0.06 % | 81.05 s |
| The Blue Danube, Op. 314 | 86.65 s | 93.60 s | 70 | 0.33 % | 0.49 % | 10.25 % | 86.75 s |
| The Blue Danube, Op. 314 | 127.27 s | 134.68 s | 75 | 0.78 % | 0.94 % | 29.37 % | 127.37 s |
| The Blue Danube, Op. 314 | 134.68 s | 145.47 s | 108 | 0.34 % | 0.14 % | 29.32 % | 134.78 s |
| The Blue Danube, Op. 314 | 198.16 s | 204.68 s | 66 | 0.69 % | 0.80 % | 29.47 % | 198.26 s |
| The Blue Danube, Op. 314 | 282.75 s | 291.69 s | 90 | 0.07 % | 0.00 % | 4.82 % | 282.85 s |
| The Blue Danube, Op. 314 | 363.35 s | 370.13 s | 68 | 0.75 % | 0.94 % | 28.81 % | 363.45 s |
| The Blue Danube, Op. 314 | 394.85 s | 406.40 s | 116 | 0.25 % | 0.02 % | 25.56 % | 394.95 s |
| The Blue Danube, Op. 314 | 424.15 s | 434.77 s | 107 | 0.00 % | 0.00 % | 0.02 % | 424.15 s |
| La Vie en Rose | 16.28 s | 24.08 s | 79 | 0.01 % | 0.01 % | 0.13 % | 16.38 s |
| La Vie en Rose | 24.08 s | 29.75 s | 57 | 0.55 % | 0.20 % | 28.14 % | 24.18 s |
| La Vie en Rose | 48.20 s | 60.07 s | 119 | 0.37 % | 0.52 % | 29.13 % | 48.30 s |
| La Vie en Rose | 60.07 s | 66.80 s | 68 | 1.05 % | 1.52 % | 29.11 % | 60.17 s |
| La Vie en Rose | 73.10 s | 81.76 s | 87 | 0.53 % | 0.92 % | 28.78 % | 73.20 s |
| La Vie en Rose | 88.63 s | 99.15 s | 106 | 0.91 % | 0.68 % | 29.44 % | 88.73 s |
| La Vie en Rose | 99.15 s | 110.69 s | 116 | 0.31 % | 0.16 % | 25.61 % | 99.25 s |
| Gymnopédie No. 1 | 14.58 s | 31.05 s | 165 | 0.22 % | 0.03 % | 29.25 % | 14.68 s |
| Gymnopédie No. 1 | 40.73 s | 46.56 s | 59 | 1.08 % | 1.03 % | 29.09 % | 40.83 s |
| Gymnopédie No. 1 | 61.39 s | 75.91 s | 146 | 0.36 % | 0.55 % | 28.71 % | 61.49 s |
| Gymnopédie No. 1 | 75.91 s | 96.22 s | 204 | 0.18 % | 0.04 % | 29.26 % | 76.01 s |
| Gymnopédie No. 1 | 96.22 s | 108.86 s | 127 | 0.40 % | 0.23 % | 29.44 % | 96.32 s |
| Gymnopédie No. 1 | 132.61 s | 139.39 s | 68 | 0.46 % | 0.16 % | 28.55 % | 132.71 s |
| Gymnopédie No. 1 | 155.81 s | 170.46 s | 147 | 0.40 % | 0.70 % | 29.21 % | 155.91 s |
| Gymnopédie No. 1 | 176.47 s | 191.01 s | 146 | 0.29 % | 0.26 % | 28.16 % | 176.57 s |
| Gymnopédie No. 1 | 191.01 s | 201.66 s | 107 | 0.33 % | 0.16 % | 28.14 % | 191.11 s |
| Gymnopédie No. 1 | 211.30 s | 217.15 s | 59 | 0.79 % | 0.98 % | 29.45 % | 211.40 s |
| Latch | 3.53 s | 12.01 s | 85 | 0.71 % | 0.34 % | 27.71 % | 3.63 s |
| Latch | 34.11 s | 41.52 s | 75 | 0.64 % | 0.99 % | 27.26 % | 34.21 s |
| Latch | 63.70 s | 71.03 s | 74 | 0.89 % | 1.53 % | 28.85 % | 63.80 s |
| Latch | 117.24 s | 124.13 s | 69 | 0.99 % | 0.90 % | 29.36 % | 117.34 s |
| Latch | 158.25 s | 165.42 s | 72 | 0.83 % | 1.03 % | 28.84 % | 158.35 s |
| Your Hand in Mine | 39.75 s | 45.28 s | 56 | 0.00 % | 0.00 % | 0.00 % | 39.75 s |
| Your Hand in Mine | 51.34 s | 58.45 s | 72 | 0.09 % | 0.01 % | 5.57 % | 51.44 s |
| Your Hand in Mine | 132.87 s | 141.94 s | 91 | 0.37 % | 0.15 % | 24.96 % | 132.97 s |
| Your Hand in Mine | 367.34 s | 377.88 s | 106 | 0.03 % | 0.07 % | 0.52 % | 367.44 s |
| Your Hand in Mine | 377.88 s | 384.87 s | 70 | 1.35 % | 1.27 % | 29.48 % | 377.88 s |
| Your Hand in Mine | 397.29 s | 403.28 s | 60 | 0.00 % | 0.00 % | 0.01 % | 397.29 s |
| Your Hand in Mine | 435.65 s | 446.45 s | 108 | 1.65 % | 2.63 % | 29.48 % | 439.55 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 75.95 s | 81.64 s | 57 | 0.00 % | 0.00 % | 0.00 % | 75.95 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 103.25 s | 113.43 s | 102 | 0.00 % | 0.00 % | 0.00 % | 103.25 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 129.34 s | 135.93 s | 66 | 0.10 % | 0.00 % | 6.26 % | 129.44 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 135.93 s | 145.01 s | 91 | 0.20 % | 0.01 % | 17.07 % | 136.03 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 234.71 s | 246.99 s | 123 | 0.00 % | 0.00 % | 0.01 % | 234.81 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 246.99 s | 258.86 s | 119 | 0.00 % | 0.00 % | 0.02 % | 246.99 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 258.86 s | 264.68 s | 59 | 0.00 % | 0.00 % | 0.09 % | 258.86 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 264.68 s | 270.88 s | 62 | 0.03 % | 0.10 % | 0.14 % | 268.68 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 397.04 s | 403.56 s | 66 | 0.31 % | 0.16 % | 14.21 % | 397.14 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 527.84 s | 537.59 s | 98 | 0.50 % | 0.12 % | 27.47 % | 527.94 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 547.80 s | 553.49 s | 57 | 0.53 % | 0.17 % | 25.18 % | 547.90 s |
| Shine On You Crazy Diamond (Pts. 1-5) | 614.68 s | 621.62 s | 70 | 0.57 % | 0.43 % | 29.14 % | 614.78 s |
| TRINITYVILLE | 15.14 s | 22.57 s | 75 | 0.45 % | 0.33 % | 24.88 % | 15.24 s |
| TRINITYVILLE | 33.13 s | 44.70 s | 116 | 0.43 % | 0.19 % | 29.46 % | 33.23 s |

## Reproduire

1. `bun install` (Playwright épinglé **1.64.1**).
2. `bunx playwright install chromium` — installe le Chromium correspondant à cette version exacte.
3. `uv run python tools/real_corpus.py` — télécharge les morceaux manquants et produit leurs analyses (requiert l'accès Deezer).
4. `bun tools/baseline-report.ts` — écrit ce fichier et le JSON machine.

Le SHA-256 affiché en fin d'exécution doit être identique sur deux exécutions. La saturation dépend du Chromium épinglé : une autre version peut décaler les pixels de 1 à 4 niveaux.

## Notes de méthode

- Le corpus synthétique est celui des snapshots (`tests/support/make_corpus.py`) ; le corpus réel ne sert qu'à ce rapport et n'entre dans aucun test de CI.
- Les snapshots de plans restent limités au synthétique : reproductibles sans réseau ni jeton.
- `p90` de la saturation est calculé sur tous les échantillons de drops confondus.
