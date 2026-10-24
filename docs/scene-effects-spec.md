# Spécification des scènes et des effets

Ce document décrit **comment le plan de spectacle est décidé** : échelles des
courbes, arbre de choix des familles, tirage déterministe, signature des drops,
durées et contrat de couleur. Il complète `src/core/show.ts` (le plan) et
`src/core/families/concert-rig.ts` (le rendu de concert).

## 1. Le temps `t`

`t` est la position de lecture en **secondes**, telle que la reçoit le rendu
(`FrameState.t`). Tous les effets sont des fonctions de `t`, jamais d'un état
accumulé : une pause, un seek ou un retour en arrière redonnent exactement la
même image.

Repères dérivés :

| Repère | Définition | Usage |
| --- | --- | --- |
| `scene.start` / `scene.end` | bornes de la scène dans le morceau | fondu, variations |
| `t - scene.start` | temps local de scène | entrées (convergence 0,9 s, rideau 1,2 s) |
| `beatIndex`, `beatPhase` | index du temps fort et phase 0..1 | chenillard, ballyhoo |
| `build`, `buildStrength` | progression et force d'une montée | prisme, blinders |
| `energy`, `bass`, `mid`, `high` | valeurs instantanées 0..1 | modulation des faisceaux |

Le plan est lui aussi une fonction pure : `buildShowPlan(analyse, réduit,
graine)` ne lit ni `Math.random` ni `Date.now`. Deux appels avec les mêmes
entrées donnent le même plan, scène par scène.

## 2. Échelles des courbes

Le serveur (`server/analysis.py`) produit des courbes à 20 Hz, échantillonnées
et sérialisées par `curve_to_points`.

- **bass**, **mid**, **high** : énergie de bande (30–150 Hz, 150–2000 Hz,
  2000–10000 Hz), lissée puis **normalisée par quantiles** (`normalize_curve`,
  quantiles 0,35–0,985) et bornée à `[0, 1]`. Une valeur de 0,5 est donc une
  valeur médiane *de ce morceau*, pas une valeur absolue.
- **energy** : `0,62 × RMS + 0,38 × (bass + mid + high) / 3`, puis
  `normalize_log_curve` (logarithme, quantiles 0,10–0,99, plancher 0,05). Cette
  courbe est **bimodale** sur le corpus de mesure : 18,9 % ≤ 0,05, 9,2 % ≥ 0,95,
  seulement 8,8 % dans `[0,40 ; 0,60]`. C'est une propriété connue du serveur,
  pas du plan.
- **onsets** : instants d'attaque, en secondes.
- **beats** : grille de temps forts ; `barStarts` en garde un sur un cycle
  (`meter × 4` temps), avec une grille régulière de secours si aucun temps
  n'est détecté.

`caractereAt(analyse, début, fin)` résume un intervalle :

- `energy` = moyenne des points d'énergie de la fenêtre (0,3 si vide) ;
- `density` = nombre d'attaques / durée (attaques/s) ;
- `brightness` = **moyenne** des points de `high` de la fenêtre (0,5 si vide).

La brillance était auparavant une **somme** de `high × 0,5` sur tous les points
à 20 Hz, donc saturée à ~1 : la branche « brillance » était prise 67 % du
temps. La moyenne la ramène sur la même échelle 0..1 que les autres courbes.

## 3. Arbre de décision des familles

`familyFor` choisit un **réservoir**, puis un tirage déterministe dans ce
réservoir. L'ordre des règles va du plus spécifique au plus général :

| Ordre | Condition | Réservoir | Justification |
| --- | --- | --- | --- |
| 1 | mode réduit, énergie < 0,22 | familles calmes | restrictions du mode réduit |
| 2 | mode réduit, densité < 0,6 att/s | familles calmes | idem |
| 3 | mode réduit | `beams`, `waves`, `rings`, `particles` | palette réduite |
| 4 | rôle `refrain` | `lyres-suspendues` / `barres-led` en alternance | ballyhoo de concert |
| 5 | rôle `montee` | `barres-led` | vague de montée |
| 6 | énergie < 0,22 | familles calmes | passage sans percussion |
| 7 | brillance > **0,30** | particules, projecteurs, spirale, anneaux, faisceaux, miroirs, défilé | spectre clair, figure aérienne |
| 8 | densité > **5,2** att/s | familles rythmiques | passage dense |
| 9 | énergie > **0,62** | familles énergétiques | passage fort |
| 10 | sinon | toutes les familles | diversité |

Les seuils 7–9 ont été recalibrés sur l'histogramme du corpus de mesure
(`tests/support/make_corpus.py`, 43 scènes) après le passage de la brillance en
moyenne :

| Seuil | Ancienne valeur | Nouvelle valeur | Histogramme | Alternative mesurée |
| --- | --- | --- | --- | --- |
| brillance | 0,62 | **0,30** | médiane 0,19, p90 0,32, max 0,71 | 0,35 (branche ~5 %) |
| densité | 2,2 | **5,2** | médiane 5,1, p75 5,3 | 4,0 (étouffe la branche énergie) |
| énergie | 0,60 | **0,62** | deux modes, rien entre 0,55 et 0,68 | 0,65 (identique en pratique) |
| brillance d'humeur | 0,68 | **0,09** | même cause d'échelle | 0,08 |

Distribution des branches sur le corpus : énergie 25,6 %, calme 20,9 %,
général 20,9 %, drop 11,6 %, brillance 11,6 %, densité 9,3 %. Aucune branche ne
dépasse 45 %, densité et énergie sont toutes deux au-dessus de 3 %.

### Rôle et humeur

- `roleFor` : une fin de montée est toujours un `drop` ; sinon la section
  **locale** décide (intro, refrain, couplet, pont → montée, outro → finale).
- Une section qui couvre ≥ 95 % du morceau est une **étiquette globale** : elle
  ne fournit ni rôle ni humeur. Le serveur ne produisant qu'une section 0→fin,
  cette règle est ce qui évite que tout le morceau soit « intense ».
- `moodFor` : silence → sombre, montée → pulsé, énergie > 0,62 → explosif,
  énergie < 0,30 → calme, brillance > 0,09 → aérien, sinon pulsé.
- Un refrain ou un impact force l'humeur explosive (hors mode réduit).

## 4. Tirage de famille

Chaque réservoir est **permuté** par Fisher-Yates avec `hash01(graine + i)` :
la graine suffit, aucun appel à `Math.random`. Le plan parcourt ensuite la
permutation au rang de la scène.

Règles :

1. la famille des **deux scènes précédentes** est exclue du tirage ;
2. la seconde exclusion ne s'applique que si le réservoir a au moins 5 entrées ;
3. la **couche de fond** est toujours exclue : elle reste commune à tout le
   morceau et ne doit jamais devenir la figure principale ;
4. une **section musicale répétée** (`group` non vide) garde sa famille et sa
   teinte d'une occurrence à l'autre.

Propriété vérifiée sur 10 000 graines : aucune répétition consécutive, 20 913
séquences distinctes de longueur 6, toutes les familles atteignables.

## 5. Signature des drops

Un `drop` ne se contente plus du rôle : il reçoit une signature déterministe de
`hashString("graine|drop|rang|force")`.

| Axe | Valeurs | Effet |
| --- | --- | --- |
| `lyres` | convergence, croisée, éventail | cible des huit lyres |
| `barres` | onde, rideau, alterné | rideau LED (une lame sur deux possible) |
| `blinders` | tous, un sur deux, chenillard | motif de la barre |
| `hue` | accent, contraste | pôle de teinte du drop |

- 54 combinaisons ; une signature n'est **jamais réutilisée dans le même
  plan**, donc deux drops à moins de 15 s diffèrent forcément.
- `pont-concert` est réservé aux montées de force ≥ 0,6 ; en dessous, les
  familles `lyres-suspendues` et `barres-led` alternent.
- Le mode réduit ne produit ni signature ni pont forcé.
- Les cycles, enveloppes et géométries existants ne changent pas : seule la
  cible (angle, rideau, motif) est choisie.

## 6. Durées et variation

- Une scène dure au moins **5 s**. Deux événements plus rapprochés fusionnent :
  on garde le meilleur score (les impacts de montée ont un bonus de 1,25).
- À 170 BPM en 3/4, un cycle vaut 4,24 s, sous le plancher : la fusion conserve
  une frontière de cycle sur deux, soit ~8,48 s (jamais 12,7 s). Médiane
  mesurée : 8,48 s, maximum 11,1 s.
- Une scène de moins de **8 s** n'a pas de variation : `scene.variant` répète sa
  famille principale, donc aucune seconde figure n'apparaît.
  *Limite connue* : le rendu ajoute aussi un saut de teinte lié à
  `variationStrength` (`render.ts`) ; le désactiver sous 8 s demanderait de
  modifier ce fichier.

## 7. Contrat de couleur

Toute scène a une **ancre** : la teinte du morceau (`track.hue`) ou sa
complémentaire (`track.accent`). Un moment fort prend la complémentaire.

- `palette.hue` reste dans **± spread** de l'ancre choisie.
- Deux scènes voisines respectent
  `MIN_HUE_STEP_EFF = min(34°, spread × 0,9)` (`minHueStepEff`).
- **L'écart gagne sur le clamp.** Si pousser la teinte dans la fenêtre de
  l'ancre ne suffit pas, on bascule sur l'autre pôle du morceau au lieu de
  réduire l'écart.
- `HUE_BUDGET_MARGIN_DEG = 12` est exporté pour le rendu : la dérive d'impact
  ou de variation ne doit pas faire sortir la teinte rendue de
  `|teinte − ancre| ≤ spread + 12°`.
- L'identité d'un groupe musical prime sur l'écart quand ses occurrences
  reviennent.

Mesures : écart voisin minimum 28,0° → **34,1°**, médiane 47,4°, 0/43 teinte
hors budget sur le corpus, et 0 paire sous le seuil effectif sur 6 morceaux ×
400 graines.

## 8. Entrées dégénérées

| Entrée | Comportement |
| --- | --- |
| durée < 5 s | une seule scène `[0, durée]` (le plancher de 5 s ne peut pas s'appliquer) |
| `tempo = 0` | grille de secours régulière (pas de 8 s), plan utilisable |
| `beats = []` | `barStarts` réguliers, pas de chenillard rythmé |
| `builds = []` | aucun drop, rôles issus des sections et du caractère |
| `sections = []` | aucun rôle de section ; caractère et raison d'événement seuls |
| couverture partielle | les courbes valent 0 hors fenêtre ; `coverage` est recopié dans le plan, le rendu sait où la donnée est fiable |
| courbe vide sur une fenêtre | énergie → 0,3, brillance → 0,5 (milieu d'échelle documenté) |
