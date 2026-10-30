# R6 — Frontières de sections : recalage borné (piste A)

Branche `feat/r6-recalage-borne`, depuis `main` `07d3b9b`
(merge de #52 / R5). Aucun merge. `src/core/render.ts` n'est pas modifié,
`src/` non plus.

**Statut : BLOQUÉ.** L'implémentation nominale (plafond 1 mesure) est en place
et les invariants durs tiennent, mais deux critères d'acceptation échouent :
**21/31 frontières justes** (attendu ≥ 24/31) et **snapshots synthétiques avec
scènes ajoutées/retirées** (interdit). L'étude de robustesse montre que le seul
réglage qui atteint 24/31 (½ mesure) fait tomber `eval:ref` à P = 0,33 /
R = 0,40. Aucun réglage de l'espace (½, 1, 2 mesures × tolérance 1,0/1,6/2,0 s)
ne satisfait les deux critères à la fois. Voir §6.

## 1. Correction du diagnostic

Le diagnostic R6 annonçait « 5 frontières cassées par le snap » puis en listait
6. Le bon chiffre est **7** : la liste oubliait **Gogo 96** (+1,64 s → +3,64 s).
Détail exact du snap historique, sur les 31 frontières de vérité :

| Frontière | Avant snap | Après snap | Sens |
|---|---:|---:|---|
| Focus 47 | −1,37 (juste) | −3,90 (décalée) | cassée |
| Focus 137 | −0,91 (juste) | −2,88 (décalée) | cassée |
| Focus 194 | +0,14 (juste) | +3,07 (décalée) | cassée |
| Gogo 96 | +1,64 (juste) | +3,64 (décalée) | cassée |
| Karma 81 | −1,80 (juste) | −4,42 (décalée) | cassée |
| Karma 131 | +0,38 (juste) | −2,25 (décalée) | cassée |
| Minimum 124 | −0,68 (juste) | −3,26 (décalée) | cassée |
| Gogo 175 | +2,61 (décalée) | +1,12 (juste) | réparée |
| Minimum 51 | +3,29 (décalée) | +0,71 (juste) | réparée |

Bilan : **7 cassées, 2 réparées**, 25/31 → 20/31 (net −5).

## 2. Implémentation

`server/structure.py` uniquement, plus `ANALYZER_VERSION` dans
`server/analysis.py` (« 5 » → « 6 »).

1. `_boundaries` calcule les frontières d'impact exactement comme avant (même
   `_peaks`, même snap ±3 s, même fusion) et rend, pour chaque frontière
   conservée, **le pic de nouveauté d'origine** (`origins`).
2. `detect_structure` calcule `merged_drops`, puis `reprises`, **avant** tout
   repositionnement ; les deux listes sont figées (`anchors`).
3. `_recalage_boundaries` repositionne ensuite chaque frontière :
   - cible = temps fort le plus « retour de production » dans la portée
     historique (`RECALAGE_MAX_SHIFT = 3 s`), calculée depuis le **pic
     d'origine**, pas depuis la frontière déjà recadrée ;
   - acceptée si elle reste dans **±1 mesure** (`meter × beatPeriod`) du pic,
     ou si elle tombe à `RECALAGE_ANCHOR_TOLERANCE = 1,6 s` d'un drop/reprise
     gelé ;
   - sinon, meilleur temps fort de la zone libre ;
   - jamais au-delà des voisines : nombre, ordre et identité des frontières
     inchangés.
4. Constantes nommées : `RECALAGE_FREE_SHIFT_BARS`, `RECALAGE_MAX_SHIFT`,
   `RECALAGE_ANCHOR_TOLERANCE`. Aucune règle par titre.
5. Les seuils de drops (`:441-446`), `REPRISE_MAX_TROUGH_ENERGY` et
   `src/core/render.ts` ne sont pas touchés.

## 3. Invariants durs — tenus

| Vérification | Résultat |
|---|---|
| Drops identiques sur les 13 titres | **oui**, 0 ajout / 0 retrait / 0 déplacement (comparaison ms, module R5 vs R6 sur les mêmes features) |
| Reprises identiques | **oui**, mêmes horodatages, forces et sources |
| `test_r5_reprises.py` | 2 passed |
| `verify:safety` | `SÉCURITÉ OK` : 0 fenêtre > 3 flashs/s, 0 flash post-drop, 10 drops |
| `render-purity` | 2 passed, 0 px |
| `pytest tests/` | 195 passed |
| `typecheck` / `lint` / `build` | OK |

## 4. Critères d'acceptation — deux échecs

| Critère | Attendu | Mesuré | Verdict |
|---|---|---:|---|
| Frontières de vérité | ≥ 24/31 justes ±2 s | **21/31** | **ÉCHEC** |
| `eval:ref` P / R | ≥ 0,50 / ≥ 0,60 | 0,50 / 0,60 | OK |
| Minimum / Focus faux refrains | ≤ 1 chacun | 1 / 1 | OK |
| Snapshots synthétiques | pas de scène ajoutée/retirée | **6 ajouts/retraits, 1 famille changée sur explosif** | **ÉCHEC** |
| Drops / reprises identiques | oui | oui | OK |
| R5, safety, purity | verts | verts | OK |

### 4.1 Avant / après des 31 frontières de vérité

| Titre | Vérité | Avant | Après | |
|---|---:|---:|---:|---|
| Focus | 15,0 | +0,58 juste | +0,58 juste | |
| Focus | 47,0 | −3,90 décalée | −3,39 décalée | améliorée, non corrigée |
| Focus | 72,0 | −0,39 juste | −0,39 juste | |
| Focus | 137,0 | −2,88 décalée | −2,88 décalée | |
| Focus | 152,0 | −0,81 juste | −0,81 juste | |
| Focus | 194,0 | +3,07 décalée | +3,07 décalée | |
| Focus | 200,0 | −2,93 décalée | −2,93 décalée | |
| Focus | 226,0 | +4,57 décalée | +5,09 décalée | |
| Gogo | 13,0 | +5,14 décalée | +5,14 décalée | |
| Gogo | 31,0 | +0,65 juste | +0,65 juste | |
| Gogo | 79,0 | +0,62 juste | +0,62 juste | |
| Gogo | 96,0 | +3,64 décalée | +3,64 décalée | |
| Gogo | 129,0 | −1,41 juste | −1,41 juste | |
| Gogo | 175,0 | +1,12 juste | +1,12 juste | |
| Gogo | 191,0 | +1,12 juste | +1,12 juste | |
| Karma | 13,0 | +1,03 juste | +1,03 juste | |
| Karma | 64,0 | +0,09 juste | +0,09 juste | |
| Karma | 81,0 | −4,42 décalée | −3,38 décalée | **non corrigée** |
| Karma | 98,0 | −0,03 juste | −0,03 juste | |
| Karma | 131,0 | −2,25 décalée | **+1,91 juste** | **réparée (marge 0,09 s)** |
| Karma | 183,0 | −0,51 juste | −0,51 juste | |
| Karma | 201,0 | −1,24 juste | −1,24 juste | |
| Karma | 218,0 | −1,08 juste | −1,08 juste | |
| Minimum | 14,0 | −0,39 juste | −0,39 juste | |
| Minimum | 41,0 | +0,03 juste | +0,45 juste | |
| Minimum | 51,0 | +0,71 juste | **+3,73 décalée** | **dégradée** |
| Minimum | 68,0 | +0,01 juste | +0,01 juste | |
| Minimum | 102,0 | −1,41 juste | −0,13 juste | |
| Minimum | 124,0 | −3,26 décalée | **+0,60 juste** | **réparée** |
| Minimum | 138,0 | −1,00 juste | −1,00 juste | |
| Minimum | 151,0 | +3,16 décalée | +3,16 décalée | |

Total : 20/31 → **21/31** ; |écart| moyen 1,72 → 1,66 s ; moyenne signée
−0,08 → +0,40 s ; médiane −0,03 → +0,09 s ; p90 3,90 → 3,64 s.

- **Dégradations juste → décalée (1)** : Minimum 51 (+0,71 → +3,73). Son snap
  historique de −2,58 s n'est corroboré par aucun drop (le drop y est déjà
  manqué, hors périmètre) : le plafond d'une mesure l'empêche.
- **Réparations décalée → juste (2)** : Karma 131 (−2,25 → +1,91) et
  Minimum 124 (−3,26 → +0,60).
- **Karma 81 n'est pas corrigée** : −4,42 → −3,38 s. Le pic de nouveauté est à
  79,20 s ; dans ±1 mesure (2,04 s) le meilleur score de retour est 77,62 s
  (+0,348), pas 80,76 s (−0,010). Il faudrait un plafond de ½ mesure pour
  l'atteindre (−0,78 s sur Karma 81).

### 4.2 Déplacements par titre (frontières de sections)

| Titre | Déplacées | Médiane | Max |
|---|---:|---:|---:|
| One More Time | 5 | 1,44 s | 4,25 s |
| Bolero | 7 | 2,69 s | 3,60 s |
| They Don't Care About Us | 3 | 1,00 s | 4,18 s |
| La Vie en Rose | 5 | 3,32 s | 4,55 s |
| Gymnopédie No. 1 | 0 | — | — |
| Latch | 4 | 1,96 s | 3,95 s |
| Your Hand in Mine | 3 | 1,02 s | 1,04 s |
| Shine On You Crazy Diamond | 26 | 0,87 s | 3,95 s |
| TRINITYVILLE | 3 | 4,16 s | 4,62 s |
| Gogo | 2 | 1,00 s | 1,51 s |
| Minimum | 4 | 2,15 s | 3,85 s |
| Karma | 7 | 1,05 s | 4,16 s |
| Focus | 4 | 2,24 s | 3,99 s |

Le déplacement peut dépasser 3 s (jusqu'à 4,62 s) parce que la frontière
d'impact et la cible de recadrage peuvent être de part et d'autre du pic
d'origine (snap historique jusqu'à 3 s d'un côté, plafond jusqu'à 2 s de
l'autre). C'est légal vis-à-vis de « liste, ordre, nombre inchangés », mais
c'est l'origine du churn de plans.

## 5. Robustesse

`justes/31` sur les frontières de vérité, P/R globaux `eval:ref` (les 4 titres
annotés). Les drops/reprises restent gelés et identiques dans tous les cas.

| Plafond | Tolérance drop | Justes/31 | P | R |
|---|---:|---:|---:|---:|
| ½ mesure | 1,0 s | **25** | **0,33** | **0,40** |
| ½ mesure | 1,6 s | **24** | **0,33** | **0,40** |
| ½ mesure | 2,0 s | **24** | **0,33** | **0,40** |
| 1 mesure | 1,0 s | 21 | 0,50 | 0,60 |
| **1 mesure (nominal)** | **1,6 s** | **21** | **0,50** | **0,60** |
| 1 mesure | 2,0 s | 21 | 0,50 | 0,60 |
| 2 mesures | 1,0 s | 20 | 0,50 | 0,60 |
| 2 mesures | 1,6 s | 20 | 0,50 | 0,60 |
| 2 mesures | 2,0 s | 20 | 0,50 | 0,60 |

**Paramètres fragiles (marge < 10 %) :**

- **Plafond : très fragile.** Entre ½ et 1 mesure, on perd 3 à 4 frontières
  justes mais on **gagne** 2 refrains justes (P passe de 0,33 à 0,50). Aucune
  valeur intermédiaire n'a été trouvée qui tienne les deux.
- **Tolérance drop : sans effet mesurable** entre 1,0 et 2,0 s (mêmes
  résultats partout). Ce n'est pas elle qui contraint.
- **Karma 131** est « réparée » à +1,91 s, soit **0,09 s sous la tolérance
  ±2 s** (marge 4,5 %). Toute variation de seuil la fait basculer.

## 6. Refrains par titre, avant / après

| Titre | Avant | Après | Changement |
|---|---:|---:|---|
| One More Time | 3 | 4 | **+1 (93,414)** |
| Bolero | 0 | 0 | — |
| They Don't Care About Us | 1 | 1 | — |
| La Vie en Rose | 2 | 2 | — |
| Gymnopédie No. 1 | 0 | 0 | — |
| Latch | 2 | 2 | — |
| Your Hand in Mine | 0 | 0 | — |
| Shine On You Crazy Diamond | 2 | 2 | — |
| TRINITYVILLE | 0 | 2 | **+2 (32,206 ; 177,609)** |
| Gogo | 3 | 3 | — |
| Minimum | 1 | 1 | — |
| Karma | 1 | 1 | — |
| Focus | 1 | 1 | — |

`eval:ref` reste à P = 0,50 / R = 0,60 et Minimum/Focus à 1 faux chacun, mais
les nouveaux refrains de One More Time et TRINITYVILLE ne sont pas annotés :
ils ne sont ni validés ni comptés comme faux. C'est un changement de
comportement non couvert par la métrique.

## 7. Snapshots et scènes réelles

### Synthétiques (`bun run snapshots`)

4 pistes sur 6 changent, sur les deux fichiers (`corpus.json` et
`corpus-reduced.json`) :

- 128bpm : 6 → 5 scènes (une scène retirée) ;
- 128bpm-low : 6 → 5 scènes (une scène retirée) ;
- 170bpm : 4 → 5 scènes (une scène ajoutée), rôle `couplet` → `montee`,
  `finale` → `couplet`, **famille `rings` → `mirror` sur une scène
  `explosif`** ;
- rich : fins de scènes déplacées, famille/variante changées.

Interdits constatés : **scènes ajoutées/retirées** (6 au total) et **famille
changée sur une scène explosive** (1). Le critère n'est pas tenu.

### Réelles (13 titres, plans `buildShowPlan`, appariement au start à ±0,25 s)

| Type | Nombre |
|---|---:|
| Scènes ajoutées | 114 |
| Scènes retirées | 119 |
| Horodatage seul | 52 |
| Rôles changés | 2 (dont 0 vers `drop`) |
| Familles changées | 58 |
| **Familles changées sur scène explosive** | **33** |
| Variantes changées | 24 |

Les frontières bougeant de 1 à 4,6 s, les scènes ne s'apparient plus : le plan
réel est recomposé bien au-delà d'un simple décalage d'horodatage. Aucun
`role → drop` cependant.

## 8. Hors périmètre (non touché)

Les drops manqués de **Minimum 51/102** et **Karma 76,58** relèvent de l'étage
drop (`structure.py:441-446`) et non du recalage : à 51,711 s,
`B_creux = 0,205` (> 0,15) et `ΔE = −0,278` ; à 100,589 s,
`B_creux = 0,158` et `ΔB = −0,079` ; à 76,579 s, `B_creux = 0,242` et gains
négatifs. `REPRISE_MAX_TROUGH_ENERGY` et les seuils de drops restent intacts.

## 9. Recommandation

Ne pas merger en l'état. Deux options, à arbitrer :

1. **½ mesure** : 24-25/31 justes et Karma 81 corrigée, mais P = 0,33 /
   R = 0,40 → viole le critère `eval:ref`.
2. **Conserver 1 mesure** : `eval:ref` et les invariants tiennent, mais
   21/31 et snapshots rouges → viole les critères frontières et snapshots.

En l'état, la piste A ne peut pas satisfaire simultanément « ≥ 24/31 justes »
et « P ≥ 0,50 / R ≥ 0,60 » : le seul levier qui améliore la position des
frontières (réduire le plafond) déplace les refrains corroborés. Il faut soit
rouvrir le critère frontières, soit accepter que R6 ne traite pas Karma 81 au
niveau section.
