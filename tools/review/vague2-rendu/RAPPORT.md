# Vague 2 — rendu des impacts

Mesures sur le corpus réel : 10 morceaux, **75 drops**, image 320×180, rendu
Chromium headless réel (qualité 1, réglages par défaut).

## Ouverture — ce que disait la vague 1

`tools/baseline-report.json` (bloc `saturationReal`, seul bloc de saturation
versionné ; `tools/vague1-report.json` n'en contient pas) :

- 75 drops, **max 0,2948**, p90 0,0031, moyenne 0,0040, 6 942 échantillons.
- Les 5 pics : **377,882 s** et **439,553 s** (Your Hand in Mine),
  **198,259 s** (The Blue Danube), **33,235 s** (TRINITYVILLE),
  **211,402 s** (Gymnopédie n° 1).

Ces cinq pics valent tous 0,2945–0,2948 sur des morceaux très différents : le
plateau est bien structurel.

## Chantier 1 — le plafond

### Cause

Dans l'ancien `render.ts`, le lavage blanc était :

```ts
Math.min(0.5, FLASH_CEILING * min(settings.flashes, 1.5) * realDrop)
```

soit `min(0,5 ; 0,72 × force)`. À partir de `force ≥ 0,69`, **tous** les drops
atteignaient 0,5 d'opacité, donc le même pic de saturation. Preuve par variation
du facteur (corpus synthétique, même outil) :

| facteur du plafond | max de saturation |
| ---: | ---: |
| 0,30 | 0,1318 |
| 0,50 | **0,2891** |
| 0,70 | 0,2942 |

Le max suit le facteur jusqu'à buter sur le plafond géométrique de la mesure
(~0,295 : la vignette et la part de l'écran réellement blanchissable).

### Correctif

Le lavage d'impact n'est plus un voile plein écran plafonné : c'est un **disque
radial** dont le **rayon** dépend de `drop.strength`
(`0,12 + 0,30 × force` × `min(w, h)`), avec une attaque de 80 ms, un plateau de
280 ms puis une traîne de 350 ms. Pendant ce lavage, le flash plein écran est
éteint : un seul événement blanc, le disque. Un drop faible blanchit donc une
surface plus petite et n'atteint jamais le pic d'un drop fort.

### Résultat

| | avant | après |
| --- | ---: | ---: |
| corrélation de Spearman force ↔ pic | 0,941 | **0,907** |
| pic max | 0,2948 | **0,2008** |
| drops ≥ 0,25 | 50 / 75 | **0 / 75** |
| valeurs de pic distinctes (3 déc.) | 28 | **52** |

Le plateau commun a disparu (0 drop au-dessus de 0,25 après), et la corrélation
reste au-dessus de la cible de 0,6.

## Chantier 2 — sécurité photosensible

Métrique ajoutée à `tools/saturation-report.ts` : luminance moyenne Rec. 709 de
chaque image, à 30 Hz, sur tout le morceau ; un flash est une **transition
rapide** ≥ 0,10 entre deux échantillons consécutifs suivie d'une descente ≥ 0,10
dans les 0,5 s ; comptage sur fenêtre glissante de 1 s. Une seconde métrique
compte les transitions de **part de blanc** (> 0,05), qui distinguent un flash
plein écran d'un simple pulse coloré.

Cadence corrigée dans `flashAdmitted` : au-dessus de 150 BPM (période < 0,4 s),
un temps fort sur deux pendant la fenêtre de drop, et un temps fort à moins de
0,34 s d'un impact ne double plus son flash.

| | avant | après |
| --- | ---: | ---: |
| pire fenêtre normale | 3/s | **3/s** |
| fenêtres > 3/s | 0 | **0** |
| part de blanc max en mode réduit | 0,295 | **0,172** |
| flash plein écran en mode réduit | oui (lavage + flash) | **non** |

En mode réduit, `flashAlphaAt` et `surgeAlpha` retournent 0 et le bloc de lavage
est gardé par `!reduced` : aucun voile blanc plein écran n'est dessiné. Les
transitions de luminance qui subsistent (≤ 3/s sur One More Time) viennent des
changements de scène et des familles, pas d'un flash ; la part de blanc ne
dépasse jamais 0,172, contre 0,295 pour l'ancien voile plein écran. Le seuil
« plein écran » (≥ 0,25 de blanc) n'est atteint sur aucune piste réduite.

## Chantier 3 — lisibilité de l'impact

Largeur d'impact = durée cumulée, à 30 Hz, où la saturation dépasse 50 % de son
pic, par drop.

| | avant | après |
| --- | ---: | ---: |
| min | 0,033 s | **0,333 s** |
| médiane | 0,133 s | **0,467 s** |
| max | 2,733 s | 0,967 s |

Cible tenue : médiane dans [0,15 ; 0,60] s, aucune largeur < 0,08 s. Le wash de
6,5 s (projecteurs colorés) n'a pas été touché : ce n'est pas l'impact.

## Chantier 4 — pureté après un seek

`renderFrame` appelle `ctx.reset()` au début de la première image qui suit un
saut de lecture (écart > 0,5 s), jamais entre deux images continues.

Coût mesuré en désactivant le reset du harnais (médiane sur 40 seeks, Chromium
headless, rendu logiciel) :

| résolution | image de seek | image continue suivante | surcoût |
| --- | ---: | ---: | ---: |
| 320×180 | 0,40 ms | 0,30 ms | **+0,10 ms** |
| 1280×720 | 0,30 ms | 0,30 ms | **+0,00 ms** (dans le bruit) |

Le test `render-purity` **ne passe pas** sans le reset du harnais : sans lui,
672 pixels diffèrent (delta max 9) entre le rendu continu et le seek. Le reset
côté production ne suffit pas, car le canvas continu conserve son propre
historique. Le harnais garde donc son reset, documenté dans
`tests/metrics/README.md` et dans le test.

## Tableau par morceau réel

| morceau | drops | pic avant | pic après | flashs/s avant | flashs/s après | largeur méd. avant | largeur méd. après |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| One More Time | 5 | 0,295 | 0,176 | 2 | 2 | 0,133 | 0,467 |
| Bolero | 8 | 0,290 | 0,170 | 2 | 1 | 0,133 | 0,467 |
| They Don't Care About Us | 7 | 0,290 | 0,181 | 2 | 1 | 0,133 | 0,467 |
| The Blue Danube, Op. 314 | 12 | 0,295 | 0,190 | 3 | 3 | 0,100 | 0,467 |
| La Vie en Rose | 7 | 0,295 | 0,182 | 2 | 0 | 0,133 | 0,500 |
| Gymnopédie No. 1 | 10 | 0,295 | 0,178 | 1 | 1 | 0,133 | 0,467 |
| Latch | 5 | 0,293 | 0,188 | 2 | 1 | 0,167 | 0,567 |
| Your Hand in Mine | 7 | 0,295 | 0,201 | 2 | 1 | 0,100 | 0,467 |
| Shine On You Crazy Diamond | 12 | 0,292 | 0,170 | 2 | 1 | 0,133 | 0,500 |
| TRINITYVILLE | 2 | 0,294 | 0,180 | 2 | 1 | 0,133 | 0,533 |

JSON complets : `before.json` / `after.json` (hors git, > 500 Ko à eux deux).
Captures 960×540 : `before-captures/` et `after-captures/` (hors git). Les
captures « après » sont prises 0,12 s après l'instant du pic de la vague 1,
le temps que le disque atteigne son plateau ; les « avant » sont à l'instant
exact du pic.

## Vérifications

- `bun run typecheck` : vert.
- `bun run lint` : vert.
- `bun run test` : vert.
- `bun run snapshots` : « snapshots à jour » (aucun octet de plan modifié).
- `render-purity` : 0 pixel, delta 0 (reset du harnais conservé, voir ci-dessus).

## Pas fait / hors périmètre

- Aucune modification de `show.ts`, `server/*`, des snapshots de plan, de
  `real_corpus.json`, de la baseline ni des tolérances existantes.
- Le wash de projecteurs de 6,5 s n'a pas été raccourci (non mesuré comme
  l'impact).
- Le mode live n'est pas couvert par la métrique de saturation (le disque
  d'impact est désactivé en live, comme avant).

## Risques

- Le pic de saturation descend de 0,295 à ~0,20 : l'impact est moins
  « éblouissant » qu'avant, volontairement, pour dépendre de la force.
- La mesure de largeur à 30 Hz a une résolution de 33 ms ; le minimum mesuré
  (333 ms) est loin du seuil, donc la conclusion est robuste.
- Le coût du reset est mesuré en rendu logiciel headless ; sur GPU il peut
  varier, mais reste une opération unique par seek.
