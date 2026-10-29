# R5 — Reprises de production (refrains sans flash)

Branche `feat/reprises-refrains`, une seule PR depuis `main` (après #51).
`src/core/render.ts` n'est pas modifié (ni code ni commentaires). Aucune règle
par titre. Les seuils du détecteur de drops (`B_gain`, `before_bass`) ne sont
pas touchés : `drops` reste produit par exactement le même chemin de code.

## 1. Diagnostic (aucun code)

Une **reprise** est le retour de la production après un creux net, **sans
condition de basse** : sur la house et l'électro, la basse continue pendant le
break, seul le niveau d'ensemble revient. Critère retenu (mesuré sur les
courbes, identique pour tous les titres) :

- creux avant le retour : `E_creux ≤ 0,25` ;
- production revenue : `E_retour ≥ 0,50` (fenêtre de 4 s) ;
- le retour tient : `E_sustain ≥ 0,30` (4 s suivantes) ;
- saut creux → retour : `E_retour − E_creux ≥ 0,30` ;
- le bloc qui commence est plus fort que le précédent : `ΔE_bloc ≥ 0,05` ;
- la densité ne s'effondre pas : `D_bloc ≥ 0,5 × D_précédent`.

La première entrée de production (cause B) suit le même critère, mais elle
n'est une reprise que si le bloc précédent est **audible** (`E ≥ 0,15`) : une
intro quasi silencieuse reste l'exposition du morceau. Ce seuil sépare Focus
15,6 s (intro 0,06 → exposition) de They Don't Care 10,5 s (bloc 0,18 →
reprise). Aucun seuil n'est propre à un titre.

### Reprises candidates sur les 13 titres

`ΔE bloc` = énergie du bloc moins celle du bloc précédent. `Drop` = une reprise
de la liste est aussi un drop détecté (donc soumise au flash). Vérité : les
quatre titres annotés (`tests/ground-truth/`) ; pour Latch, One More Time et
They Don't Care, les refrains cités dans la consigne R5 ; sinon « non annoté ».

| Titre | Temps (s) | E | ΔE bloc | Basse | Densité | Drop | Vérité |
|---|---:|---:|---:|---:|---:|:--:|---|
| One More Time | 30.4 | 0.69 | +0.48 | 0.26 | 1.12 | non | refrain validé |
| One More Time | 61.7 | 0.84 | +0.10 | 0.46 | 2.55 | non | refrain validé |
| One More Time | 93.4 | 0.86 | +0.02 | 0.55 | 3.12 | oui | rien (non annoté) |
| One More Time | 257.9 | 0.84 | +0.12 | 0.48 | 3.04 | oui | rien (non annoté) |
| One More Time | 288.2 | 0.72 | -0.11 | 0.40 | 2.62 | oui | rien (non annoté) |
| Bolero | 54.5 | 0.78 | +0.43 | 0.12 | 4.24 | non | rien (non annoté) |
| They Don't Care About Us | 10.5 | 0.57 | +0.39 | 0.37 | 3.58 | non | refrain validé |
| They Don't Care About Us | 156.5 | 0.79 | +0.18 | 0.42 | 3.21 | oui | rien (non annoté) |
| La Vie en Rose | 27.4 | 0.67 | +0.29 | 0.23 | 3.15 | oui | rien (non annoté) |
| La Vie en Rose | 108.5 | 0.63 | +0.20 | 0.28 | 2.82 | oui | rien (non annoté) |
| Latch | 79.9 | 0.74 | -0.04 | 0.46 | 5.47 | oui | rien (non annoté) |
| Latch | 95.6 | 0.83 | +0.09 | 0.47 | 4.66 | non | refrain validé |
| Latch | 127.1 | 0.88 | +0.21 | 0.50 | 5.42 | non | refrain validé |
| Latch | 158.6 | 0.84 | +0.14 | 0.59 | 1.74 | oui | rien (non annoté) |
| Latch | 189.6 | 0.75 | -0.11 | 0.47 | 5.30 | oui | rien (non annoté) |
| Latch | 205.8 | 0.90 | +0.16 | 0.48 | 4.10 | non | rien (non annoté) |
| Your Hand in Mine | 73.8 | 0.94 | +0.28 | 0.60 | 5.57 | oui | rien (non annoté) |
| Your Hand in Mine | 119.8 | 0.87 | +0.35 | 0.50 | 5.04 | oui | rien (non annoté) |
| Your Hand in Mine | 377.9 | 0.92 | +0.46 | 0.58 | 2.52 | oui | rien (non annoté) |
| Your Hand in Mine | 427.3 | 0.63 | +0.27 | 0.05 | 3.88 | non | rien (non annoté) |
| Your Hand in Mine | 439.4 | 0.95 | +0.31 | 0.69 | 2.25 | oui | rien (non annoté) |
| Shine On You Crazy Diamond (Pts. 1-5) | 267.8 | 0.82 | +0.59 | 0.46 | 2.53 | oui | rien (non annoté) |
| Shine On You Crazy Diamond (Pts. 1-5) | 453.7 | 0.70 | +0.20 | 0.29 | 3.24 | oui | rien (non annoté) |
| TRINITYVILLE | 32.2 | 0.79 | +0.21 | 0.34 | 3.94 | oui | rien (non annoté) |
| TRINITYVILLE | 177.6 | 0.82 | +0.25 | 0.37 | 3.75 | oui | rien (non annoté) |
| Gogo | 31.6 | 0.81 | +0.56 | 0.41 | 4.74 | non | rien |
| Gogo | 79.6 | 0.77 | -0.04 | 0.38 | 4.95 | oui | drop validé + refrain validé |
| Gogo | 127.6 | 0.80 | +0.33 | 0.38 | 4.99 | oui | drop validé |
| Gogo | 176.1 | 0.79 | +0.11 | 0.40 | 4.88 | oui | drop validé + refrain validé |
| Minimum | 137.0 | 0.57 | +0.40 | 0.21 | 4.49 | oui | drop validé |
| Karma | 64.1 | 0.78 | +0.17 | 0.56 | 4.08 | oui | rien |
| Karma | 98.0 | 0.96 | +0.42 | 0.73 | 4.81 | oui | drop validé |
| Karma | 216.9 | 0.95 | +0.72 | 0.73 | 5.26 | oui | drop validé + refrain validé |
| Focus | 71.6 | 0.78 | +0.09 | 0.41 | 5.32 | oui | drop validé |
| Focus | 151.2 | 0.82 | +0.57 | 0.49 | 4.28 | oui | drop validé |
| Focus | 198.6 | 0.65 | +0.02 | 0.31 | 4.61 | oui | drop validé |

**36 reprises candidates** sur les 13 titres.

| Titre | Reprises | Dont drops |
|---|---:|---:|
| One More Time | 5 | 3 |
| Bolero | 1 | 0 |
| They Don't Care About Us | 2 | 1 |
| La Vie en Rose | 2 | 2 |
| Gymnopédie No. 1 | 0 | 0 |
| Latch | 6 | 3 |
| Your Hand in Mine | 5 | 4 |
| Shine On You Crazy Diamond (Pts. 1-5) | 2 | 2 |
| TRINITYVILLE | 2 | 2 |
| Gogo | 4 | 3 |
| Minimum | 1 | 1 |
| Karma | 3 | 3 |
| Focus | 3 | 3 |

**36 reprises** sur les 13 titres, dont **27 drops** : 9 reprises n'ont pas de
drop. Le maximum de reprises par 20 s est Latch (6 reprises / 12,8 tranches de
20 s = 0,47), sous la limite de 1.

## 2. Implémentation

- `Structure` porte un champ `reprises` (drops inclus). Le sous-ensemble est
  garanti par construction : la liste démarre comme une copie de `merged_drops`,
  puis on ajoute les retours d'énergie. Les horodatages des drops ne peuvent
  donc pas bouger.
- La corroboration d'un refrain utilise `reprises` au lieu de `merged_drops`
  (`REFRAIN_DROP_TOLERANCE = 0,75 s` inchangé). Une reprise sans drop peut donc
  ancrer un refrain.
- Aucun autre consommateur ne lit `reprises` : les drops seuls déclenchent le
  flash et le plateau concert (`forceConcert = role === "drop"` dans
  `src/core/show.ts`). Une reprise sans drop ne peut pas allumer la salle.

## 3. Refrains avant / après (13 titres)

« Avant » = état après R4 (PR #51). « Après » = R5.

| Titre | Avant | Après | Récupérés / ajoutés |
|---|---:|---:|---|
| One More Time | 1 | 3 | **30,441 ; 61,672** |
| Bolero | 0 | 0 | — |
| They Don't Care About Us | 0 | 1 | **10,542** |
| La Vie en Rose | 2 | 2 | — |
| Gymnopédie No. 1 | 0 | 0 | — |
| Latch | 0 | 2 | **95,620 ; 127,106** |
| Your Hand in Mine | 0 | 0 | — |
| Shine On You Crazy Diamond (Pts. 1-5) | 2 | 2 | — |
| TRINITYVILLE | 0 | 0 | — |
| Gogo | 2 | 3 | 31,649 (faux) |
| Minimum | 1 | 1 | — |
| Karma | 1 | 1 | — |
| Focus | 1 | 1 | — |

Les cinq refrains perdus de la consigne sont récupérés :
**Latch 95,6 / 127,1 ; One More Time 30,4 / 61,7 ; They Don't Care 10,5.**
Bolero et Gymnopédie restent à 0. Le refrain de Karma à 81 s reste manqué
(frontière à 76,58 s, hors tolérance ±2 s) : ce n'est pas un objectif R5.

### Évaluation de référence (`bun run eval:ref --no-render`)

| Titre | Refrains justes/proposés | Détectés | Faux |
|---|---:|---:|---:|
| Gogo | 2/3 | 3 | 1 |
| Minimum | 0/0 | 1 | 1 |
| Karma | 1/2 | 1 | 0 |
| Focus | 0/0 | 1 | 1 |
| **Tous** | **3/5** | **6** | **3** |

Précision tous titres **P = 0,50**, rappel **R = 0,60**, F1 = 0,55.
Sur les seuls titres annotés : P = 0,75, R = 0,60.

Objectifs : Minimum et Focus ≤ 1 faux → **atteint** (1 chacun) ; précision tous
titres ≥ 0,50 → **atteint au plancher exact** (0,50, contre 0,60 en R4) ;
rappel Gogo+Karma ≥ 0,60 → **atteint au plancher** (3/5 = 0,60). Le faux
refrain supplémentaire de Gogo (31,649, bloc répété après un creux) est le coût
direct de l'ouverture aux reprises sans basse.

## 4. Preuve : drops identiques

Comparaison du module R4 (`git show main:server/structure.py`) et du module R5
sur les mêmes caractéristiques audio, pour les 14 titres du manifeste (les 13
de la consigne + The Blue Danube) :

| Titre | Drops R4 | Drops R5 | Identiques |
|---|---|---|---|
| One More Time | 93.414, 257.950, 288.229 | 93.414, 257.950, 288.229 | oui |
| Bolero | — | — | oui |
| They Don't Care About Us | 156.526 | 156.526 | oui |
| The Blue Danube, Op. 314 | 111.502, 417.657, 468.277 | 111.502, 417.657, 468.277 | oui |
| La Vie en Rose | 27.400, 108.484 | 27.400, 108.484 | oui |
| Gymnopédie No. 1 | — | — | oui |
| Latch | 79.900, 158.569, 189.568 | 79.900, 158.569, 189.568 | oui |
| Your Hand in Mine | 73.816, 119.838, 377.882, 439.438 | 73.816, 119.838, 377.882, 439.438 | oui |
| Shine On You Crazy Diamond (Pts. 1-5) | 267.773, 453.741 | 267.773, 453.741 | oui |
| TRINITYVILLE | 32.206, 177.609 | 32.206, 177.609 | oui |
| Gogo | 79.621, 127.594, 176.123 | 79.621, 127.594, 176.123 | oui |
| Minimum | 136.998 | 136.998 | oui |
| Karma | 64.087, 97.965, 216.921 | 64.087, 97.965, 216.921 | oui |
| Focus | 71.610, 151.185, 198.600 | 71.610, 151.185, 198.600 | oui |

Écart de liste : **0** (aucun horodatage ajouté, déplacé ou supprimé).

## 5. Robustesse des seuils (±10 %, un seuil à la fois)

Chaque seuil `REPRISE_*` est déplacé de ±10 %, tous les autres restant fixes,
sur les mêmes features figées. « Cibles » = les 5 reprises R5 (One More Time
30,4 / 61,7 ; Latch 95,6 / 127,1 ; They Don't Care 10,5). Précision calculée sur
les quatre titres annotés (Gogo, Minimum, Karma, Focus).

| Seuil | Variation | Reprises | Cibles | Faux Min | Faux Focus | Faux Gogo | Précision |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline | — | 36 | 5/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_AFTER_ENERGY` | −10 % | 37 | 5/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_AFTER_ENERGY` | +10 % | 35 | 4/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_SUSTAIN_ENERGY` | −10 % | 36 | 5/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_SUSTAIN_ENERGY` | +10 % | 36 | 5/5 | 1 | 1 | 1 | 0,50 |
| **`REPRISE_MAX_TROUGH_ENERGY`** | **−10 %** | **34** | **3/5** | 1 | 1 | 1 | 0,50 |
| `REPRISE_MAX_TROUGH_ENERGY` | +10 % | 38 | 5/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_ENERGY_JUMP` | −10 % | 37 | 5/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_ENERGY_JUMP` | +10 % | 36 | 5/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_SECTION_GAIN` | −10 % | 36 | 5/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_SECTION_GAIN` | +10 % | 36 | 5/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_DENSITY_KEEP` | −10 % | 36 | 5/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_DENSITY_KEEP` | +10 % | 36 | 5/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_PREVIOUS_ENERGY` | −10 % | 36 | 5/5 | 1 | 1 | 1 | 0,50 |
| `REPRISE_MIN_PREVIOUS_ENERGY` | +10 % | 36 | 5/5 | 1 | 1 | 1 | 0,50 |

**Seuil fragile : `REPRISE_MAX_TROUGH_ENERGY`.** À −10 % (0,225), les creux des
cibles One More Time 61,7 s et Latch 127,1 s valent 0,24 et passent au-dessus du
seuil : **2 cibles perdues** (3/5). La marge n'est que de 0,01. `REPRISE_MIN_AFTER_ENERGY`
à +10 % (0,55) perd une seule cible (They Don't Care 10,5, retour 0,5125) : à
surveiller, mais pas fragile au critère ≥ 2. Les douze autres variantes gardent
les 5 cibles, les faux compteurs et la précision.

## 6. Non-régression

| Vérification | Commande | Résultat |
|---|---|---|
| Sécurité photosensible | `bun run verify:safety` | `SÉCURITÉ OK` : 0 fenêtre > 3 flashs/s, 0 flash post-drop, blanc réduit max 0,000, 10 drops |
| Pureté du rendu | `bun test tests/unit/render-purity.test.ts` | 2 pass, 0 pixel d'écart |
| Teinte des reprises | `bun run hue` | Gogo 170,0° ; Minimum 169,6° ; Karma 153,9° ; Focus 169,4° — identiques à R4 |
| Snapshots de plans | `bun run snapshots` | à jour, 6 pistes, **0 scène changée** (corpus synthétique) |
| Types | `bun run typecheck` | OK |
| Lint | `bun run lint` | OK |
| Tests front | `bun test tests/` | 385 pass |
| Tests serveur | `uv run pytest tests/ -q` | 195 pass (5 tests ajoutés, dont les features figées R5) |
| Build | `bun run build` | OK |

### Scènes de plans réels changées

Les snapshots versionnés portent sur le corpus synthétique et ne changent pas.
Sur les analyses réelles, le diff `buildShowPlan` avant/après représente
**28 diffs** : **10 changements de rôle** et **15 cascades de famille/teinte**
sur les 13 titres, plus **3 diffs Blue Danube** (1 rôle, 2 cascades), hors
périmètre de la consigne. Aucune scène ne reçoit le rôle `drop` : les nouvelles
reprises ne déclenchent ni flash ni plateau.

| Titre | Scène | Début | Fin | Type | Reprise d'ancrage | Drop |
|---|---:|---:|---:|---|---:|:--:|
| One More Time | 3 | 30.441 | 46.533 | rôle couplet→refrain | 30.441 | non |
| One More Time | 5 | 61.672 | 73.398 | rôle couplet→refrain | 61.672 | non |
| One More Time | 6 | 73.398 | 85.124 | rôle couplet→refrain | 61.672 | non |
| One More Time | 7 | 85.124 | 93.414 | rôle couplet→refrain | 61.672 | non |
| One More Time | 9 | 105.140 | 116.843 | cascade famille/teinte | — | — |
| One More Time | 10 | 116.843 | 127.106 | cascade famille/teinte | — | — |
| One More Time | 12 | 138.321 | 154.227 | cascade famille/teinte | — | — |
| One More Time | 13 | 154.227 | 166.301 | cascade famille/teinte | — | — |
| One More Time | 14 | 166.301 | 180.814 | cascade famille/teinte | — | — |
| One More Time | 15 | 180.814 | 188.871 | cascade famille/teinte | — | — |
| One More Time | 16 | 188.871 | 200.620 | cascade famille/teinte | — | — |
| One More Time | 17 | 200.620 | 212.486 | cascade famille/teinte | — | — |
| One More Time | 18 | 212.486 | 220.845 | cascade famille/teinte | — | — |
| One More Time | 21 | 244.785 | 257.950 | cascade famille/teinte | — | — |
| They Don't Care About Us | 1 | 10.542 | 22.175 | rôle couplet→refrain | 10.542 | non |
| They Don't Care About Us | 2 | 22.175 | 34.319 | rôle couplet→refrain | 10.542 | non |
| The Blue Danube, Op. 314 | 28 | 335.691 | 345.165 | rôle couplet→refrain | 335.691 | non |
| The Blue Danube, Op. 314 | 29 | 345.165 | 356.496 | cascade famille/teinte | — | — |
| The Blue Danube, Op. 314 | 30 | 356.496 | 367.990 | cascade famille/teinte | — | — |
| Latch | 8 | 95.620 | 110.852 | rôle couplet→refrain | 95.620 | non |
| Latch | 10 | 127.106 | 140.388 | rôle couplet→refrain | 127.106 | non |
| Latch | 11 | 140.388 | 152.184 | cascade famille/teinte | — | — |
| Latch | 12 | 152.184 | 158.569 | cascade famille/teinte | — | — |
| Latch | 17 | 205.798 | 217.757 | cascade famille/teinte | — | — |
| Gogo | 3 | 31.649 | 43.607 | rôle couplet→refrain | 31.649 | non |
| Gogo | 4 | 43.607 | 50.620 | rôle couplet→refrain | 31.649 | non |
| Gogo | 10 | 99.637 | 111.618 | cascade famille/teinte | — | — |
| Gogo | 11 | 111.618 | 127.594 | cascade famille/teinte | — | — |

## 7. Paramètres ajoutés

`server/structure.py` :

- `REPRISE_MIN_AFTER_ENERGY = 0.50`
- `REPRISE_MIN_SUSTAIN_ENERGY = 0.30`
- `REPRISE_MAX_TROUGH_ENERGY = 0.25`
- `REPRISE_MIN_ENERGY_JUMP = 0.30`
- `REPRISE_MIN_SECTION_GAIN = 0.05`
- `REPRISE_MIN_DENSITY_KEEP = 0.5`
- `REPRISE_MIN_PREVIOUS_ENERGY = 0.15` (première entrée de prod uniquement)
- champ `Structure.reprises` (drops inclus)

Aucun seuil de drop, aucune règle par titre, `src/core/render.ts` inchangé.
