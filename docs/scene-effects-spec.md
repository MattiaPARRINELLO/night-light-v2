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
| 4 | rôle `refrain` | `lyres-suspendues`, `barres-led`, `lyres-poursuite`, `lyres-duo`, `lyres-eventail` | ballyhoo et duo de concert |
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
  familles de concert du réservoir alternent, dont `lyres-poursuite`,
  `lyres-duo` et `lyres-eventail`.
- `orientationLyre` accepte un geste optionnel (`"auto"` par défaut, donc
  comportement historique inchangé) : `poursuite` (une tête court le long du
  pont), `eventail` (ouverture large), `croisement` (les faisceaux se croisent)
  et `vague` (onde d'inclinaison). Ces gestes ne sont utilisés que par les
  nouvelles familles.
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

## 9. Bordure LED

Une couche **permanente** (`src/core/families/bordure.ts`), dessinée par
`render.ts` après les blinders, sur `permanent` : elle ne suit donc pas le fondu
de scène.

- **Géométrie** : `NOMBRE_DIODES_BORDURE = 240` diodes réparties sur le
  périmètre d'un rectangle collé au bord (retrait de `0,3 %` du petit côté) : un vrai ruban LED,
  dense. `positionBordure` renvoie le point, l'angle du segment et le côté
  (`haut`, `bas`, `gauche`, `droite`). Le dessin échantillonne ce ruban selon la
  qualité (une diode sur 1, 2 ou 3) sans déplacer les positions.
- **Rendu en couches, comme un vrai ruban** :
  1. **piste permanente** — un trait à peine visible qui donne l'axe du cadre ;
  2. **corps** — un tronçon par diode, dont l'alpha va de 0,03 à 0,88 selon le
     motif : c'est lui qui porte le contraste allumé/éteint ;
  3. **cœur** — un trait plus fin et plus clair au centre, pour le rendu néon ;
  4. **diffusion locale** — un halo court uniquement autour des zones allumées ;
  5. **émetteurs** — de petites diodes colorées, échantillonnées selon la
     qualité, avec une variation déterministe de brillance entre voisines.
  Aucun cœur blanc : la diode reste de la couleur du ruban. Même au silence,
  chaque tronçon garde une veilleuse (`poidsMotif ≥ 0,08`), donc la bordure
  reste lisible sans jamais s'allumer en entier.
- **Motif** : `motifBordure` choisit par blocs de 8 temps forts, à partir du
  rôle et de la graine — **jamais de l'énergie courante**, qui oscille et ferait
  clignoter la bande d'une image à l'autre autour d'un seuil. L'énergie ne
  module que l'intensité. Motifs : `rail`, `haut`, `cote`, `alternance`
  (un côté puis l'autre toutes les 4 pulsations), `chenillard`, `respiration`,
  `plein`. À chaque temps fort, le beat **reprend le dessus** : tout le ruban
  monte vers l'allumé sur ~75 % de la fusion, puis le motif réapparaît en
  s'éteignant. Le mode réduit plafonne cette reprise à 25 %.
  Un `drop` n'est jamais un mur continu : ses blocs alternent entre
  `plein`, `chenillard` et `alternance`, donc le bandeau s'éteint par endroits
  même au plus fort. `poidsMotif` rend la
  part allumée de chaque diode, veilleuse comprise.
- **Couleur** : `couleurBordure` donne **une seule teinte de fil** : la teinte
  de la scène, avec une ondulation périodique de 8° sur le pourtour (aucun
  raccord visible au bouclage) et une dérive lente dans le budget de la scène.
  Pas de diodes multicolores : deux voisines sont presque identiques.
- **Blinder de couleur** : le ruban sert aussi de barre de blinders. Sur un
  impact (drop, refrain, finale, fin de montée), `blinderBordure` reprend
  l'inertie du filament (`intensiteBlinder`, décalage par bloc, budget de
  flashs) et ajoute son éclat à l'intensité. Attaque lissée sur ~50 ms (petit
  comme gros blinder), pour qu'aucune diode ne passe de 0 au maximum en une
  seule image. Un **petit blinder** pulse en plus
  sur chaque beat (`f.beat × (0,3 + 0,4 × basse)`), léger et présent même hors
  impact ; le gros éclat prend le maximum des deux. Il est plus sensible que la barre
  tungstène : drop, refrain, finale, fin de montée et couplet énergique
  (énergie > 0,55), avec un gain de 1,2. Il reste **de la couleur de la
  scène** : pas de tungstène, seulement plus de saturation et de luminosité.
  Jamais en mode réduit.
- **Intensité** : rail permanent, part du motif modulée par la respiration,
  éclat d'impact et blinder de couleur dosés par `settings.flashes`.
- **Mode réduit** : plafond `0,3`, facteur `0,5`, pas de chenillard ni d'éclat.
- **Coût** : deux tronçons et un halo local par diode, plus deux remplissages
  pour les émetteurs échantillonnés, sans transformation ni dégradé radial.

## 10. Profil hard (mode rave)

Le profil `hard` est le **mode rave** de l'interface : une décision **de morceau**, pas de
scène. Il est résolu une fois dans `buildShowPlan` (`resolveShowProfile`) puis recopié dans
`plan.profile`. Les humeurs de scène restent celles du modèle existant ; le profil ne fait
que changer leur vocabulaire.

### Détection (`auto`)

Mesures sur les fenêtres où l'énergie dépasse 0,45, échantillonnées toutes les 0,5 s :

| mesure | seuil |
| --- | --- |
| énergie médiane | ≥ 0,70 |
| basses médianes − aigus médians | ≥ 0,30 |
| part de fenêtres sous 0,30 d'aigus | ≥ 0,50 |

Les bandes étant normalisées indépendamment par l'analyseur, l'écart basses − aigus mesure
la **forme du mix** (basses tenues, aigus en éclats), pas un niveau absolu. Le réglage
`RenderSettings.hard` vaut `auto` par défaut ; `on` force le profil, `off` l'interdit.

### Effets sur le plan

- palette tirée de `HARD_TRACK_PALETTES` (rouge/glace, violet/acide, braise/cyan,
  magenta/arc), spread 52–58° ;
- réservoir `HARD_FAMILIES` pour les scènes hors calme, hors refrain/montée/impact ;
- fond tiré de `HARD_BACKDROPS` (grille, tunnel, vagues) ;
- saturation des scènes non calmes portée à 1, luminosité des humeurs fortes abaissée
  (0,64 explosif, 0,58 pulsé), intensité +0,06 ;
- fondus d'entrée et de sortie raccourcis (0,35–0,50 s au lieu de 0,7–1,2 s / 0,9 s).

Le mode réduit force `standard` : c'est un mode de confort, il ne doit pas hériter d'un
vocabulaire agressif.

### Effets sur le rendu

- fond plus noir (`drawBackground`) et halo central réduit ;
- attaque de flash de temps fort à 20 ms, de drop à 80 ms, gain d'opacité de 12 %
  (`FLASH_ATTACK_*_HARD_SEC`, `HARD_FLASH_BOOST`) ;
- **stroboscope hard** (`hardStrobeAlpha`) : chaque temps fort est admis
  (`flashAdmitted(..., hard)`), puis le clignotement suit `hardStrobeDivisions`, de 4 à
  12 éclats **par temps** selon l'énergie et l'impact, soit ~9 à 28 Hz à 140 BPM. Chaque
  éclat alterne entre la teinte principale et la complémentaire, et les flashs de temps
  fort ainsi que le wash d'impact sont colorés dans l'accord de la scène. La phase
  repart de zéro à chaque temps (`beatPhase`), donc pas de trou « strobe, pause, strobe »
  quand la vitesse change. Il s'ajoute au flash de temps fort et s'éteint sans basse ni
  kick, en mode réduit, ou si `settings.flashes = 0` ;
- **cycle du strobe hard** (`core/strobe.ts`) : 8 temps forts, soit 4 temps de plein
  strobe, 2 temps de creux où le plein écran se tait et où la bordure LED strobe seule,
  puis 2 temps de reprise. Le cycle est calé sur `beatIndex`, donc stable après un seek.
  Pendant le plein strobe, `hardStrobeFamily` remplace la famille de la scène par
  `lyres-eventail`, et `drawRaveLayers` empile par-dessus `crossfire`, `burst` et
  `spots` (tirs croisés, rayons centraux, projecteurs mobiles), avec saturation 1,
  luminosité +0,04 et budget de teinte ×1,5 : le strobe tombe sur une scène de rave
  hyper colorée, pas sur une nappe ;
- bordure LED : part de `strobe` élargie sur les impacts et présente à l'occasion sur les
  couplets (`motifPourBloc`), toujours sous le budget de flashs et jamais en mode réduit ;
- **mouvement de rave** : caméra (`raveCamera`) avec zoom pulsé sur le kick, rotation et
  balayage lents autour du centre ; l'éventail de lyres passe de 0,17 à 1,15 rad/s, le
  burst tourne en continu (×11), les tirs croisés et les projecteurs balaient le cadre.
  Le fond, la vignette et la bordure restent fixes : c'est la lumière qui bouge, pas
  l'image entière ;
- **lasers scan** (`drawRaveLasers`) : jusqu'à 36 faisceaux fins, moitié depuis la scène,
  moitié depuis le plafond, avec 2 à 3 images de rémanence ; ils balaient le cadre et
  changent de teinte le long de la rangée ;
- **confettis** (`drawRaveConfetti`) : pluie de particules colorées pendant les drops ;
- **CO2** (`drawRaveCo2`) : deux jets latéraux qui montent et retombent sur l'impact ;
- **onde de choc** (`drawRaveShockwave`) : anneau qui part du centre sur les 0,9 s qui
  suivent un impact ;
- **panneaux LED** (`drawRavePanels`) : deux bandes verticales sur les bords, en
  chenillard et damier sur les pics ;
- **mur de blinders** : en rave, les douze cellules passent en `tous` sur les pics et en
  `chenillard` sinon, avec un pulse sur chaque kick et une teinte arc-en-ciel ;
- **coupes glitch** (`drawGlitchCuts`) : trois bandes horizontales décalées sur les drops
  (`drop > 0,3`), déterministes et sans état ;
- **balayage arc-en-ciel** : `lampHue` décale la teinte de `f.t × 55 + index × 22` en mode
  rave, et les strobes tournent de `f.t × 60`.
