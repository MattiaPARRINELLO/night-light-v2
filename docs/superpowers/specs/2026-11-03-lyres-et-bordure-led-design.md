# Lyres du pont, duo avec les barres, bordure LED — design

## Intention

Le pont haut porte huit lyres qui ne servent aujourd'hui que deux gestes
(convergence de drop, ballyhoo de refrain), et les seize barres LED du milieu
ne sortent presque qu'en montée. On veut :

1. de nouveaux effets portés par les lyres du haut ;
2. des scènes où les lyres du haut et les petites barres du milieu jouent
   **ensemble** ;
3. une **bordure de LEDs** qui fait le tour de l'écran et s'allume d'elle-même
   aux moments très lumineux, par-dessus n'importe quelle famille.

## Décisions

- **Bordure = couche permanente**, pas une famille : elle décide seule de ses
  allumages, quel que soit l'effet de scène. (Choix du partenaire.)
- **Gestes de lyres = cas optionnels ajoutés à `orientationLyre`** (choix
  retenu, approche 2) : un paramètre `geste` avec `"auto"` par défaut, donc les
  familles et tests existants gardent exactement le comportement actuel.

## Non-objectifs

- Changer la cinématique existante des lyres, barres et blinders.
- Faire de la bordure une famille tirable au sort.
- Modifier le plan de spectacle au-delà de l'ajout des nouvelles familles dans
  les réservoirs.

## Contraintes

- Tout reste une fonction pure de `(t, view, scene, frameState)` : aucun état
  accumulé, donc pause / seek / retour arrière redonnent la même image.
- Mode réduit : aucune nouvelle famille de concert, et la bordure est plafonnée
  (`≤ 0,3`) sans chenillard ni éclat.
- La bordure suit le budget `settings.flashes` et l'identité colorée du morceau
  (`lampHue` / `contrastHue`).
- `bun run typecheck`, `bun lint`, `bun run test` doivent rester verts.

## Gestes de lyres

Nouveau type exporté :

```ts
export type GesteLyre = "auto" | "poursuite" | "eventail" | "croisement" | "vague";
```

`orientationLyre(f, view, index, role = f.scene.role, geste: GesteLyre = "auto")`.

- `auto` : comportement actuel, inchangé.
- `poursuite` : une seule tête éclairée à la fois, la course avance le long du
  pont au rythme des temps forts et boucle sans saut (distance circulaire).
- `eventail` : les huit têtes s'écartent depuis la verticale, plus largement que
  l'éventail de montée, avec une respiration lente.
- `croisement` : moitié gauche vers la droite, moitié droite vers la gauche ;
  les faisceaux se croisent au centre.
- `vague` : une onde d'inclinaison court de tête en tête.

Chaque geste est lissé (sinus lent ou `beatSwing`), avec les mêmes bornes
d'angle et de continuité que l'existant.

## Familles

Trois familles ajoutées à `FamilyId`, `FAMILY_LABELS`, aux réservoirs rythmique
et énergétique, et à `CONCERT_FAMILIES` :

| famille | contenu |
| --- | --- |
| `lyres-poursuite` | lyres seules, geste `poursuite` |
| `lyres-duo` | lyres geste `croisement` **et** barres LED en vague/rideau |
| `lyres-eventail` | lyres geste `eventail` **et** barres LED en rideau |

Le tirage de refrain passe de l'alternance binaire à `pickFamily` sur
`lyres-suspendues`, `barres-led`, `lyres-poursuite`, `lyres-duo`,
`lyres-eventail`. La montée garde `barres-led` comme figure canonique.

`lyresSuspendues` et `barresLed` sont refactorés en fonctions internes
paramétrées (`dessinerLyres(geste)`, `dessinerBarres()`), les familles
existantes appelant la valeur `"auto"`.

## Bordure LED

Nouveau module `src/core/families/bordure.ts`, exporté par `families/index.ts`.

- `NOMBRE_DIODES_BORDURE` (240) réparties uniformément sur le périmètre d'un
  rectangle collé au bord (retrait de ~0,3 % du petit côté) : c'est un ruban LED dense, pas une
  guirlande. `positionBordure(index, w, h)` renvoie le point, l'orientation du
  segment et le côté (`haut`, `bas`, `gauche`, `droite`). Le dessin
  échantillonne ce ruban selon la qualité sans déplacer les positions.
- La bordure est un **fil continu toujours visible** : halo extérieur, cœur de
  trait, puis diodes. Même au repos, chaque diode garde une veilleuse
  (`poidsMotif ≥ 0,3`). Elle ne s'allume donc jamais « tout d'un coup » : un
  motif décide seulement quelles diodes sont **renforcées**, et il change de
  lui-même au fil du morceau :
  - `rail` : veilleuse discrète sur tout le pourtour ;
  - `haut` : seulement le bord supérieur ;
  - `cote` : un seul côté, qui alterne avec son opposé (`alternance`) ;
  - `chenillard` : un segment lumineux court le long du périmètre ;
  - `respiration` : tout le pourtour pulse lentement ensemble ;
  - `progression` : le pourtour se remplit depuis un coin, puis se vide ;
  - `haut-bas` : le bord haut se remplit de gauche à droite, puis le bord bas ;
  - `milieu` : la lumière part du centre de chaque bord et gagne les extrémités ;
  - `vague` : deux ondes courent le long du ruban ;
  - `plein` : tout s'allume, réservé aux impacts et aux passages très forts.
- `motifBordure(f, view)` choisit le motif de façon déterministe (rôle, bloc de
  temps forts, graine — jamais l'énergie courante, qui provoquerait du
  clignotement autour des seuils) ; `poidsMotif(f, view, index, motif)` donne la
  part allumée de chaque diode. Un changement de motif est fondu sur quelques
  dixièmes de seconde, jamais un interrupteur.
- `intensiteBordure(f, view, index, budgetFlash)` combine le poids du motif, un
  rail permanent faible, la respiration, l'éclat d'impact et la part de
  **blinder de couleur** (`intensiteBlinder`, même inertie de filament que la
  barre tungstène, mais sans changer la teinte). En mode réduit : plafond
  `0,3`, pas de chenillard, pas d'éclat, pas de blinder.
- **Une seule couleur de fil** : `couleurBordure(f, index)` prend la teinte de
  la scène, avec une ondulation périodique de 8° sur le pourtour (aucun raccord
  au bouclage) et une dérive lente dans son budget de teinte. Pas de diodes
  multicolores : deux voisines sont presque identiques.
- `dessinerBordure(ctx, f, view, budgetFlash)` : bloom en trois passes, tube
  diffuseur, cœur clair, puis tronçons et petits émetteurs colorés (halo court,
  variation déterministe). Pas de cœur blanc : le rendu doit lire comme une
  vraie bande LED, pas comme une guirlande.
- Appel dans `render.ts` à côté de `dessinerBlinders`, sur `permanent`, en
  `lighter`.

## Tests et mesure

- `tests/unit/bordure.test.ts` : positions sur le périmètre et déterministes,
  intensité nulle quand tout est calme, hausse sur drop/refrain, plafond du
  mode réduit, aucune valeur non finie.
- `tests/unit/concert.test.ts` : `geste: "auto"` identique à l'appel actuel,
  continuité des nouveaux gestes, poursuite qui déplace la zone éclairée.
- Régénérer les snapshots de plan (`bun run snapshots:update`) et vérifier
  qu'aucune famille nouvelle n'échoue aux propriétés du plan.
- Mettre à jour `docs/scene-effects-spec.md` (tableau des réservoirs, gestes,
  nouvelle section bordure).

## Ce qui reste à l'implémenteur

Les valeurs exactes (nombre de diodes, marges, vitesses de chenillard, seuils
d'allumage) sont ajustables à l'œil, tant que les contraintes ci-dessus sont
tenues. Le rendu doit rester lisible en 16:9 comme en portrait.
