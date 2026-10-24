# Audit des effets — état avant fusion du plan et du rendu

> Document historique conservé comme preuve de l'état d'origine (branche
> `chore/test-harness-baseline`). Les constats marqués **CODE MORT**,
> **PARTIEL** ou **DIVERGENT** ont été traités par les PR #30 (plan) et #29
> (rendu) ; la spécification à jour est `docs/scene-effects-spec.md`.


Cette page décrit ce que le spectacle **fait réellement**, règle par règle, avec
une colonne « statut » :

| statut | sens |
| --- | --- |
| **ACTIF** | la règle existe et s'applique telle que décrite ; preuve en `fichier:ligne` |
| **CODE MORT** | le code existe mais rien ne l'atteint avec les analyses réelles |
| **PARTIEL** | la règle s'applique, mais une autre règle peut l'annuler dans certains cas |
| **DIVERGENT** | le code fait autre chose que ce qui est annoncé, ou viole une règle déclarée |

<!-- À METTRE À JOUR APRÈS FUSION : tirage de famille -->
<!-- À METTRE À JOUR APRÈS FUSION : brightness (saturation > 0,62) -->
<!-- À METTRE À JOUR APRÈS FUSION : drops -->
<!-- À METTRE À JOUR APRÈS FUSION : dérive de teinte -->
<!-- À METTRE À JOUR APRÈS FUSION : flashs -->
<!-- À METTRE À JOUR APRÈS FUSION : code mort (backdrop, reason, familles inatteignables) -->

## 1. Découpage en scènes

| règle | code | statut | preuve |
| --- | --- | --- | --- |
| seuls des événements musicaux créent une frontière (section, fin de montée, retour de cycle, ouverture, finale) | `sceneBoundaries` | ACTIF | `src/core/show.ts:453-493` |
| deux événements à moins de 5 s fusionnent ; l'impact de montée gagne | `MIN_SCENE_SPAN`, score `build × 1,25` | ACTIF | `src/core/show.ts:270`, `475-491` |
| aucune scène ne dure moins de 5 s (hors morceau < 5 s) | `MIN_SCENE_SPAN` | ACTIF | `src/core/show.ts:270`, `540-544` |
| la dernière scène finit avec le morceau et devient `finale` (sauf drop final) | fin de `buildShowPlan` | ACTIF | `src/core/show.ts:674-681` |
| les scènes se suivent sans trou ni chevauchement | — | ACTIF | test `tests/unit/plan-properties.test.ts` (P1) |
| même analyse + même mode + même graine ⇒ plan identique | fonction pure | ACTIF | `src/core/show.ts:499-692`, test P6 |

## 2. Choix de la famille

| règle | code | statut | preuve |
| --- | --- | --- | --- |
| le tirage de famille dépend de la graine | `familyFor(..., turn + hash01(seed + turn) * 0.9, ...)` | **CODE MORT** | `src/core/show.ts:579` + `349` : `Math.floor` annule la fraction, la graine ne change rien (mesuré : **0 %** de familles différentes entre graines 1 et 2, `tests/unit/plan-properties.test.ts` P7) |
| `refrain` → alternance lyres suspendues / barres LED | `familyFor` | **CODE MORT** | `src/core/show.ts:360` ; le serveur n'émet jamais `kind: "refrain"` (`server/analysis.py:370-398`) |
| `montée` → barres LED | `familyFor` | **CODE MORT** | `src/core/show.ts:361` ; le rôle `montee` n'est jamais produit (voir §3) |
| brillance > 0,62 → réservoir `particles/spots/spiral/rings/beams/mirror/parade` | `familyFor` | **DIVERGENT** | `src/core/show.ts:363-365` ; `caractereAt` initialise la brillance à 0,5 (`289-305`), donc la plupart des scènes réelles dépassent 0,62 (mesure : **98,3 %** des scènes, `docs/metrics/baseline.json`) |
| au moins 6 familles distinctes sur 3 min, famille dominante < 25 % | — | ACTIF sur la piste longue | test P8 (`tests/unit/plan-properties.test.ts`) |
| chaque famille déclarée est atteignable | — | **CODE MORT** | 20 familles sur 29 ne sont jamais choisies sur le corpus (test X3) |
| deux scènes voisines n'ont jamais la même famille | — | ACTIF sur le corpus | tests P3/P4 |

## 3. Rôles et humeurs

| règle | code | statut | preuve |
| --- | --- | --- | --- |
| fin de montée → `drop` | `roleFor` | ACTIF | `src/core/show.ts:380` |
| section `intro`/`refrain`/`couplet`/`outro`/`pont` → rôle correspondant | `roleFor` | **CODE MORT** | `src/core/show.ts:381-385` ; le serveur ne produit que `kind: "section"` (`server/analysis.py:388-398`) |
| ouverture / index 0 → `intro` | `roleFor` | ACTIF | `src/core/show.ts:386` |
| libellé `montee` / `descente` / `silence` → `montee` / `finale` | `roleFor` | **CODE MORT** | `src/core/show.ts:387-388` ; l'analyse ne produit que `calme`, `intense` ou `silence` (`server/analysis.py:356-367`) |
| énergie > 0,62 → humeur `explosif` | `moodFor` | ACTIF | `src/core/show.ts:423` |
| énergie < 0,3 → humeur `calme` | `moodFor` | ACTIF | `src/core/show.ts:427` |
| brillance > 0,68 → `aerien`, sinon `pulse` | `moodFor` | **DIVERGENT** | `src/core/show.ts:428-429` ; la branche `pulse` par défaut n'est atteinte sur aucune scène du corpus (brillance saturée), test X4 |
| un impact force l'humeur explosive | `buildShowPlan` | ACTIF | `src/core/show.ts:557-558` |
| un refrain force l'humeur explosive | idem | **CODE MORT** | `src/core/show.ts:556-558` (aucun refrain détecté) |

## 4. Couleur

| règle | code | statut | preuve |
| --- | --- | --- | --- |
| une palette de morceau stable (teinte + complémentaire + spread) | `TRACK_PALETTES`, `plan.track` | ACTIF | `src/core/show.ts:250-259`, `517` |
| chaque scène reste dans ±spread de son ancre (teinte ou complémentaire) | clamp final | ACTIF | `src/core/show.ts:615-620`, test P9 |
| deux scènes voisines ont au moins 34° d'écart | `MIN_HUE_STEP` | **DIVERGENT** | `src/core/show.ts:611-620` ; le clamp ±spread s'applique APRÈS le pas minimal et peut le réduire (mesuré : **28,0°** sur la piste `e_sans_montee`, test P9) |
| les moments forts basculent sur la complémentaire | `fort` | ACTIF | `src/core/show.ts:599-602` |
| dérive continue de 0,4°/s + respiration ±14° | `sceneHue` | **DIVERGENT** | `src/core/render.ts:350-361` ; la dérive n'est pas bornée : sur 10 min elle atteint 240°, très au-delà de `spread + marge` (test X1) |
| saut de teinte à l'impact borné à 32° | `HUE_IMPACT_LIMIT` | ACTIF | `src/core/render.ts:83`, `356-359` |
| saut de teinte de drop de 26° (et non 70°) | `DROP_HUE_JUMP` | ACTIF | `src/core/render.ts:79` ; la valeur annoncée dans le README (70°) est fausse |
| accord multicolore des lampes | `lampHue`, `sceneChord` | ACTIF | `src/core/families/harmony.ts:100-118` |
| la teinte du plan est indépendante de la graine ? | `derive = hash01(seed + turn * 977)` | ACTIF (la teinte, elle, change avec la graine) | `src/core/show.ts:603-606` |

## 5. Rendu, flashs, wash

| règle | code | statut | preuve |
| --- | --- | --- | --- |
| plafond d'opacité d'un flash à 0,4 | `FLASH_CEILING` | ACTIF | `src/core/render.ts:51`, `145-155` |
| flash de temps fort espacé d'au moins 1,6 s | `FLASH_MIN_GAP` | **PARTIEL** | `src/core/render.ts:59`, `378-397` ; un impact de montée garde la priorité (`389`) et peut tomber juste après un flash de temps fort (intervalle minimal mesuré sur le corpus : **0,317 s**) |
| un flash naît dans les 0,12 s après son déclencheur | `FLASH_ATTACK_SEC` | ACTIF | `src/core/render.ts:61`, `385-386` ; test F1 |
| un flash de drop est plus fort qu'un flash ordinaire (≥ 2×) | `flashAlpha` | **DIVERGENT** | `src/core/render.ts:149-154` ; mesuré : **0,69×**, **1,52×**, **0,87×** selon les pistes (test F2) |
| wash de projecteurs après un impact | `WASH_SPAN_SEC = 6,5 s` | ACTIF | `src/core/render.ts:230-257` ; le README annonce 2,5 s |
| lavage blanc bref réservé aux vrais drops | `realDrop > 0,35` | ACTIF | `src/core/render.ts:546-556` |
| variation au milieu de phrase, bords exactement nuls | `variationStrength` | ACTIF | `src/core/render.ts:282-290` |
| plancher d'énergie visible 0,26 | `ENERGY_FLOOR` | ACTIF | `src/core/render.ts:176-181` ; test R7 |
| fond, halo et poussière indépendants du fondu de scène | `permanent` | ACTIF | `src/core/render.ts:494-508` |
| pas de `clearRect` : le fond repeint tout l'écran | fond opaque | ACTIF | `src/core/render.ts:488-492` |
| cache de vignette par contexte et dimensions | `vignetteCache` | ACTIF | `src/core/render.ts:624-647` ; test R1 (pureté sur contexte partagé) |
| qualité quantifiée par paliers, jamais sous le minimum de 3 éléments | `quantizeQuality`, `count` | ACTIF | `src/core/series.ts:81-88`, `src/core/families/util.ts:9-12` ; test R4 |
| mode réduit : aucun flash, wash, variation ni famille de concert | `reduced` | ACTIF | `src/core/render.ts:443`, `530`, `607` ; `src/core/show.ts:352-356` ; test P10 |

## 6. Champs du plan consommés par le rendu

| champ | consommé ? | preuve |
| --- | --- | --- |
| `index` | oui | `src/core/render.ts:558` |
| `start`, `end` | oui | `sceneWeight`, `variationStrength` |
| `family` | oui | `drawFamily` (`render.ts:507`) |
| `variant` | oui | `render.ts:525` |
| `palette` | oui | `render.ts:446-457` |
| `intensity` | oui | `render.ts:476`, `570` |
| `fadeIn`, `fadeOut` | oui (via `sceneWeight`) | `src/core/show.ts:732-739` |
| `mood` | oui | `src/core/families/harmony.ts:100`, `118` |
| `role` | oui | `src/core/families/concert-rig.ts:175`, `381`, `851` |
| **`backdrop`** | **non** | aucune lecture dans `render.ts` ni `families/` ; test X2 |
| **`reason`** | **non** | aucune lecture dans `render.ts` ni `families/` ; test X2 |

Le champ `plan.backdrop` existe aussi au niveau du plan (`src/core/show.ts:130`)
et n'est lu par personne : c'est le cas de code mort connu.

## 7. Ce que cette page ne couvre pas

- La photosensibilité : hors périmètre du projet (voir le cahier de tests D5).
- Les familles prises une par une : voir `src/core/families/*.ts` et
  `tests/unit/render.test.ts`.
- Les mesures chiffrées complètes : `docs/metrics/baseline.json` et
  `docs/metrics/README.md`.
