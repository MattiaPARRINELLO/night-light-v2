# Night Light : light show musical

[![CI](https://github.com/MattiaPARRINELLO/night-light-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/MattiaPARRINELLO/night-light-v2/actions/workflows/ci.yml)
[![Licence : MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](./LICENSE)

Application **personnelle** (une seule personne, aucune authentification) : Night Light
écoute la musique qui joue sur le PC, identifie le morceau, le récupère si besoin, l'analyse
avec librosa, et joue un spectacle lumineux calé sur la position réelle du lecteur. Tu
changes de morceau, le show suit.

![Démo du spectacle, calé sur la position du lecteur](./docs/images/demo-night-light.gif)

L'image est une **fonction du temps musical**, pas une réaction au volume :

- **écoute en direct du PC** : le son système (PipeWire/PulseAudio) alimente l'ambiance
  immédiate, et le lecteur est suivi par MPRIS (`playerctl`) pour connaître titre, artiste
  et position, sans toucher à ta bibliothèque ;
- **identification, récupération, analyse** : le morceau joué est résolu dans le catalogue
  Deezer et téléchargé en 128 kbps s'il n'est pas déjà en cache, puis analysé par librosa
  (tempo, temps forts, attaques, énergie, bandes, sections, montées) ;
- **rendu calé sur le temps musical** : chaque image Canvas 2D part de `audio.currentTime`
  ou de la position du lecteur, donc pause, seek et changement de morceau se recalent
  exactement.

---

## Comment ça marche

```
musique qui joue sur le PC
   │
   ├─ audio système (PipeWire/PulseAudio) ──► ambiance live immédiate (Canvas)
   │
   └─ MPRIS / playerctl : titre, artiste, position
         │
         ▼
      résolution du morceau (Deezer, streamrip, 128 kbps)
         │  cache disque si déjà téléchargé
         ▼
      analyse librosa (22 050 Hz, STFT 2048 / hop 512)
         │  tempo, temps forts, bandes, énergie, sections, montées
         │  courbes [secondes, 0..1] à 20 Hz
         ▼
      show Canvas 2D calé sur la position du lecteur
```

Quatre décisions qui expliquent le reste :

- **deux signaux, deux rôles** : l'audio système donne une ambiance immédiate, MPRIS
  fournit le morceau et sa position ; le show programmé s'appuie sur l'analyse, pas sur le
  volume capté ;
- **analyse côté serveur et cache disque** : librosa coûte trop cher au navigateur,
  l'analyse est faite une fois, conservée avec le morceau téléchargé, puis rejouable sans
  réseau ;
- **des courbes plutôt que des événements** : les bandes et l'énergie sont échantillonnées
  à 20 Hz, ce qui rend n'importe quel instant lisible sans rejouer l'audio ;
- **aucun état accumulé dans le rendu** : tout dérive de la position du lecteur, donc une
  pause, un seek ou un changement de morceau n'a rien à corriger.

## Lancer en local

```bash
bun install            # dépendances de l'interface (Vite)
bun run dev            # API + interface via Portless → https://nightlight.localhost
```

`bun run dev` lance deux processus :

- l'API d'analyse (`uvicorn`, **127.0.0.1 uniquement** — elle n'est pas exposée sur le réseau) ;
- l'interface (`vite`) publiée par Portless sur `https://nightlight.localhost`, qui relaie `/api` vers l'API.

Sans Portless : `bun run api` (API) et `bunx vite` (interface) séparément, puis ouvrir
l'adresse affichée par Vite.

Pour le mode direct, il faut un lecteur qui expose MPRIS et `playerctl` (voir
[Synchronisation Show / lecture externe](#synchronisation-show--lecture-externe)).
Sans lecteur, le dépôt de fichier reste disponible.

Pour ne lancer que l'API (par exemple derrière un proxy existant), `bun run api` démarre
`uvicorn` sur `127.0.0.1:8787`. Les autres réglages (`DEEZER_ARL`, limites, chemins…) se
lisent dans l'environnement, à définir dans ton shell ou via un `.env` sourcé par lui.

## Utiliser

1. Lance un morceau dans un lecteur qui expose MPRIS : Deezer, VLC, Spotify, MPD, ou un
   navigateur Chromium sous Linux.
2. Night Light détecte le titre et l'artiste, récupère le morceau dans le catalogue Deezer
   s'il n'est pas déjà en cache, l'analyse, puis démarre le show calé sur la position du
   lecteur. Le morceau suivant est préparé de la même façon.
3. Si le morceau n'est pas dans le catalogue (édition rare, live, fichier local), dépose-le
   dans la zone **« Dépose ta musique ici »** (glisser-déposer ou bouton « Choisir un
   fichier »).
4. Formats acceptés au dépôt : **MP3, WAV, OGG, FLAC, M4A/AAC, AIFF, WebM**, vérifiés
   d'après les octets du fichier et pas d'après son extension (un MP3 renommé `.wav` est
   reconnu comme MP3).
5. Pendant le show : lecture/pause (`Espace`), recommencer (`R`), plein écran (`F`),
   volume (`↑`/`↓`), position (`←`/`→`), intensité, flashs, profil standard/rave,
   mode rave (`H`), blackout instantané (`B`), intensité réduite, sans flashs,
   retour à l'écran de dépôt.
6. Tu peux relancer le show autant de fois que tu veux : tant que la session vit, l'analyse
   et le fichier audio sont gardés côté serveur, il n'y a rien à recalculer.

## Identification et récupération (Deezer)

C'est le chemin principal : à partir du titre et de l'artiste annoncés par MPRIS, l'API
(`POST /api/resolve`) cherche le morceau dans le catalogue Deezer, le télécharge si besoin,
le met en cache, puis lance l'analyse. Un morceau déjà téléchargé n'est pas récupéré une
seconde fois.

La recherche se fait **dans le catalogue Deezer**, par titre et artiste — pas dans des
clips vidéo — et le morceau est téléchargé **en 128 kbps MP3**, le plus bas niveau de
qualité proposé, choisi délibérément : l'analyse et la lecture ne justifient pas plus
lourd. Le morceau récupéré est ensuite mis en cache comme un fichier déposé.

Prérequis :

1. **streamrip** — le CLI qui cherche et télécharge. C'est le fork maintenu
   ([Stensel8/streamrip](https://github.com/Stensel8/streamrip), Python ≥ 3.14), installé
   à côté du projet : le serveur l'appelle en sous-processus.

   ```bash
   git clone https://github.com/Stensel8/streamrip ~/.local/share/night-light/streamrip
   uv tool install ~/.local/share/night-light/streamrip
   ```

   > streamrip exige **Python ≥ 3.14** ; le serveur d'analyse, lui, tourne sur
   > **Python 3.11 à 3.13** (voir `pyproject.toml`). Les deux environnements sont
   > indépendants.

2. **Le cookie ARL de ta session Deezer**, dans `DEEZER_ARL` (voir `.env.example`). Il se
   lit dans les cookies du navigateur connecté à Deezer : DevTools → Application →
   Cookies → `arl`. Sans lui, la récupération est refusée avec un message explicite, et le
   reste de l'application fonctionne normalement.

> ⚠️ **Avertissement.** Cette récupération télécharge des morceaux depuis Deezer en
> s'appuyant sur une session personnelle, ce qui est contraire aux conditions
> d'utilisation de Deezer et peut poser un problème de droits. La fonctionnalité est
> **désactivée tant que `DEEZER_ARL` est vide** et n'a de sens que dans un cadre
> strictement privé. Pour un usage partagé, préfère le dépôt de fichiers locaux.

Le provider (`server/retrieve/deezer.py`) n'appelle que le CLI : il écrit pour streamrip une
copie privée (`0600`) de sa configuration dans le répertoire de cache, y pose le cookie et
force le niveau de qualité le plus bas. Aucun secret n'est écrit dans le dépôt.

## Confidentialité et sécurité

- Le son est capturé et le morceau téléchargé sur **ta machine**. Seule la recherche du
  titre interroge Deezer ; le fichier récupéré reste dans le cache local.
- Au dépôt manuel, le fichier part de ton navigateur vers **ton serveur local**, et c'est
  indiqué sur l'écran de dépôt.
- Aucun fichier audio n'est jamais servi publiquement : il faut connaître l'identifiant de
  session, il est supprimé quand tu changes de morceau, à la fermeture du serveur, et au
  bout de `SESSION_TTL_SEC` (30 min) sans activité.
- Seules les **données d'analyse** sont conservées en mémoire pour le rejeu ; le fichier
  lui-même n'est gardé que le temps de la lecture, puis effacé.
- Le répertoire des sessions doit s'appeler `night-light-sessions` : c'est une garde
  explicite contre une purge qui effacerait autre chose (voir `server/store.py`).
- Serveur : limite de taille (`MAX_FILE_MB`), de durée (`MAX_DURATION_SEC`), délai d'analyse
  (`ANALYZE_TIMEOUT_SEC`), nombre d'analyses simultanées, vérification du type réel,
  sessions dans un répertoire dédié. Aucune clé ni mot de passe dans le code : tout se règle
  par variables d'environnement (voir `.env.example`). Le cookie Deezer `DEEZER_ARL` n'est
  ni versionné ni journalisé : il n'est recopié que dans la configuration privée (`0600`)
  que streamrip utilise, dans le répertoire de cache.

**N'expose pas ce serveur à Internet** : il n'a pas d'authentification. Il
**refuse de démarrer** sur une adresse non locale (`HOST=0.0.0.0` par exemple) ;
il faut lever explicitement ce garde-fou avec `ALLOW_NETWORK=1`.

## Ce que l'analyse produit

Réellement calculé par librosa sur les échantillons décodés (22 050 Hz, STFT 2048/hop 512) :

| donnée | méthode |
| --- | --- |
| tempo, temps forts | `onset_strength` + `beat_track` (recherche de phase) |
| métrique | autocorrélation de l'accentuation des temps forts : 3 ou 4 temps, repli à 4 si le signal n'est pas concluant |
| attaques | `onset_detect`, corrigé du retard de groupe de la STFT |
| basses / médiums / aigus | énergie des bandes 30–150, 150–2000, 2000–10 000 Hz, lissée puis normalisée ; `midLow` (150–600 Hz) et `midHigh` (600–2500 Hz) subdivisent le médium |
| énergie globale | RMS + bandes, normalisation logarithmique (reste lisible dans les passages modérés) |
| section | un découpage local par nouveauté (chroma + timbre) : `intro`, `couplet`, `refrain`, `pont`, `outro` ; un refrain est un matériau répété corroboré par une reprise de production, ou répété au moins trois fois et contrasté avec ses voisins (R7) |
| montées | dérivée de la courbe d'énergie, filtrée sur l'amplitude gagnée ; un cut de 150–450 ms avant l'impact est enjambé pour caler le drop sur le premier onset qui suit le silence |

Toutes les courbes sont envoyées en points `[secondes, 0..1]` à 20 Hz — compacts et
directement échantillonnables depuis le navigateur.

### Limites connues

- **M4A/AAC** : libsndfile ne les ouvre pas toujours ; le serveur les décode alors via
  `ffmpeg`. Si `ffmpeg` est absent, ces formats sont refusés avec un message clair.
- **Tempo** : la détection de battement reste une estimation. Sur des morceaux sans
  percussion marquée (ambient), elle peut désigner la moitié ou le double du tempo ressenti.
  Le spectacle s'appuie donc aussi sur les courbes d'énergie et de bandes, pas seulement sur
  les temps forts.
- **Sections** : le découpage est local et automatique. Un refrain exige un
  matériau répété ; il est corroboré par une reprise de production, ou reconnu
  par une répétition franche (au moins trois occurrences) qui tranche avec ses
  voisins. Les frontières restent approximatives (décalage possible de quelques
  secondes), et les morceaux sans refrain chanté gardent des couplets répétés.
- La lecture dans le navigateur dépend des codecs du navigateur : si un morceau analysé
  n'est pas lisible, l'application le dit et propose un format plus sûr (WAV, MP3).
- **Récupération Deezer** : la recherche de streamrip ne renvoie pas la durée d'un
  résultat. La durée est donc vérifiée sur le fichier téléchargé (`ffprobe`, tolérance
  0,5 %) : un écart franc écarte le candidat au lieu d'accepter une autre version (live,
  remix, edit).

## Le spectacle

Trente-deux familles visuelles tournantes. Le tirage suit la graine du morceau par une
permutation déterministe : deux morceaux différents ne déroulent pas les mêmes familles,
et les deux scènes précédentes sont exclues pour éviter les répétitions.

<p>
  <img src="./docs/images/spectacle-1.webp" width="32%" alt="Faisceaux et anneaux">
  <img src="./docs/images/spectacle-2.webp" width="32%" alt="Anneaux concentriques">
  <img src="./docs/images/spectacle-3.webp" width="32%" alt="Faisceaux croisés">
</p>

Les projecteurs se déclinent en figures de
concert : faisceaux, projecteurs, miroirs, défilé, tirs croisés, rideau de lumière,
rayonnement, formes projetées, pendules, couronne, pluie de lumière, portique, étoile,
vortex, lyres, lyres suspendues, barres LED, pont concert. Les autres jouent sur la
matière et la géométrie : tunnel, particules, vagues, grille, anneaux, volets, barres,
spirale, rosace, treillis.

Quelques figures méritent un mot, parce qu'elles ont une intention :

| famille | ce qu'elle raconte |
| --- | --- |
| **pendules** | une rangée de têtes sur un portique, la vague traverse la rangée au lieu de tout basculer d'un bloc |
| **couronne** | des têtes posées sur un arc, leurs rayons s'élancent vers le haut comme une tiare, la lumière en fait le tour |
| **faisceaux** | deux éventails jumeaux partant chacun d'un point visible — l'un au plancher, l'autre au plafond ; les deux côtés s'allument ensemble ou l'un sans l'autre |
| **pluie de lumière** | des colonnes tombent du plafond, chacune avec son cycle et sa longueur |
| **portique** | une porte de lumière qui s'ouvre sur les moments forts et se referme sur les passages calmes |
| **étoile** | un projecteur rotatif : peu de branches, un foyer qui dérive, chaque branche pulsant à son tour |
| **vortex** | un éventail vrillé dont la vrille se resserre avec l'énergie |
| **formes projetées** | des gobos (cercle, anneau, losange, triangle) répartis dans tout le cadre ; quand elles sont nombreuses, une ou deux basculent sur la couleur opposée au lieu de se déplacer |
| **lyres** | une rangée de têtes fines au sol, la vague traverse la rangée par décalage de phase — chacune s'incline tour à tour |
| **lyres suspendues** | huit têtes accrochées au pont technique, ballyhoo en refrain, éventail en montée et convergence au sol sur un impact |
| **barres LED** | seize lames très serrées sur leur traverse : onde d'inclinaison progressive en couplet, rideau parallèle en refrain et en drop |
| **pont concert** | le plateau complet, lyres et barres ensemble, déployé sur les impacts |
| **rosace** | huit pétales en V répartis au tour, un hexagone et un triangle qui tournent en sens contraires |
| **treillis** | deux nappes de faisceaux parallèles croisées en losanges, une grille lente qui s'écarte sur les temps forts |

### La scène

Le spectacle se joue désormais sur un plateau : un pont en treillis à 12-16 % de la
hauteur, une seconde traverse pour les barres LED, deux totems latéraux et une barre de
douze blinders tungstène. La structure est permanente ; seuls les faisceaux changent de
figure.

La barre de blinders se pilote par motifs : toute la barre sur un impact, une cellule
sur deux en refrain, une sur quatre en couplet, et un chenillard sur les montées. Chaque
cellule garde son inertie thermique, donc les motifs se lisent comme des mouvements de
console et non comme des interrupteurs.

Les blinders ne s'éteignent pas d'un coup : leur filament suit `exp(-Δt / 0,22 s)`, puis
passe du blanc chaud à l'ambre et au rouge avant de tomber au noir. Au-dessus de 0,6
d'intensité, un flare anamorphique étire le halo horizontalement.

Trois échelles de renouvellement se superposent, pour que l'écran ne tourne jamais en
boucle :

| échelle | durée | ce qui change |
| --- | --- | --- |
| **phrase** | 5-8 s | famille principale, palette, humeur (calme / pulsé / explosif / aérien / sombre) |
| **variation** | milieu de chaque phrase | une seconde famille surgit brièvement, avec sa propre teinte |
| **dérive** | en continu | la teinte glisse lentement (0,4°/s) et respire de ±14° autour de celle de la scène |

### Rien n'apparaît ni ne disparaît d'un coup

Trois règles, toutes vérifiées par des tests :

- **les mouvements sont calés sur le tempo** (`beatSwing`) : la cible change à chaque pas,
  l'interpolation arrive sur les 70 % du pas puis tient — le projecteur se réoriente *sur* le
  temps fort et reste en place le reste du temps ;
- **chaque élément s'allume et s'éteint progressivement** (`elementEnvelope`) : montée
  lissée, maintien, extinction lissée, jamais de saut. Le cycle se compte en temps forts et
  chaque élément a son décalage, donc ils s'allument l'un après l'autre ;
- **le fond, le halo et la poussière sont permanents** (couche `permanent` du rendu) : ils ne
  dépendent pas du fondu de scène, donc l'écran ne passe jamais par le noir entre deux scènes.

L'ampleur d'un balayage et la cadence des allumages suivent l'énergie : un couplet se
contente d'un mouvement étroit et lent, un refrain ouvre largement et vit plus vite.

### Des faisceaux diffus

Les projecteurs ne dessinent pas des triangles aux arêtes nettes : `softBeam` donne à
chaque faisceau un bord fondu, comme de la lumière dans la fumée d'une salle.

Le flou n'est pas appliqué sur place, faisceau par faisceau : il passe par une **surface de
fumée**. Les faisceaux y sont déposés en basse résolution, la surface est floutée **une seule
fois** par image, puis remontée — l'agrandissement finit d'adoucir les bords. C'est ce qui
rend la diffusion tenable : un `ctx.filter` s'applique à toute la surface couverte, et chaque
appel coûte en pratique une passe pleine toile. Vingt projecteurs allumés ensemble, c'était
donc vingt passes pleine toile par image affichée — mesuré à **2 images par seconde**, contre
**40** avec la surface de fumée, sur la même scène et à qualité égale.

Le rayon du flou suit la taille de l'écran (5 à 16 px) : le même spectacle est aussi diffusé
sur une télévision que sur un mur de projection. Il ne s'éteint **jamais** — même sur une
machine qui souffle, où seule la résolution de la surface baisse. À défaut de surface
(navigateur sans toile, mode réduit), le profil est approché par superposition de couches
(`beamLayers`).

### La couleur

Le spectacle éclaire une salle de soirée : les teintes sont franches, et **chaque morceau a
sa palette**, choisie une fois d'après le morceau lui-même et tenue du premier au dernier
plan (`plan.track`). Elle se compose d'une teinte principale et d'une complémentaire :

- chaque scène reste dans la fenêtre de l'une ou de l'autre ;
- les **moments forts basculent sur la complémentaire** — c'est le saut de couleur qui marque
  un refrain ou un drop ;
- dès qu'une scène a plusieurs sources, ses projecteurs ne sont pas monochromes : ils se
  répartissent sur un **accord** tiré du cercle chromatique (`lampHue`). Quatre accords
  alternent d'une scène à l'autre — demi-complémentaire, triade, carré, hexade — et l'accent
  du morceau remplace toujours son 180 : la scène est multicolore, mais ses couleurs viennent
  toutes de la palette du morceau. Les lampes parcourent l'accord avec un pas qui ne retombe
  jamais sur la voisine, donc une rangée se lit comme un dégradé d'univers, pas comme deux
  tons alternés ;
- quand les formes projetées sont nombreuses, **une ou deux basculent brièvement sur la couleur
  opposée** (`colorFlip`) : le passage à l'opposée est une rotation de la roue de couleurs, donc
  progressif — c'est le déplacement remplacé par la couleur, là où un motif de plus ne se lirait
  pas ;
- l'éclairage suit l'humeur : explosif à 0,96 de saturation et 0,76 de luminosité — près du
  blanc, c'est ce qui « allume la salle » — contre 0,62 / 0,44 pour les passages calmes, afin
  que l'impact se voie ;
- les sauts de teinte à l'impact sont bornés à 32° : la lumière change, la palette tient.

### Le mode rave (profil hard)

Le répertoire « gros son » — rap sombre, trap, phonk, morceaux du type *PTSD*, mais aussi
les gros sons de club — ne réagit pas comme de l'électro claire : les basses tiennent
l'image, les aigus arrivent par éclats, et un traitement de « soirée lumineuse » y paraît
mou. Le plan bascule donc sur un profil `hard`, affiché partout comme le **mode rave**,
quand le morceau est à la fois **fort**, **sombre** et **tenu dans les basses** (énergie
médiane ≥ 0,70, écart médian basses − aigus ≥ 0,30, majorité de fenêtres fortes sous 0,30
d'aigus). Le réglage **Profil** du HUD et le bouton **Rave / H** du dashboard permettent
de le forcer ou de le couper quand l'analyse se trompe.

Le profil change quatre choses, sans toucher aux humeurs de scène :

- une palette néon, saturation maximale et luminosité moyenne (0,58 à 0,64) posée sur un
  fond presque noir : rouge/glace, violet/acide, braise/cyan, magenta/arc, avec des écarts
  de teintes larges pour multiplier les couleurs vives d'une même scène ;
- un réservoir de familles qui découpent l'image — volets, barres, grille, tirs croisés,
  rayons, maillages, poursuites de lyres — au lieu des nappes et figures rondes ;
- des fonds permanents compatibles (grille, tunnel, vagues lentes) et des coupes plus
  courtes entre scènes ;
- un rendu plus noir : fond abaissé, flashs plus secs (attaque de 20 ms au lieu de 40 ms,
  gain de 12 %) et un vrai stroboscope hard : chaque temps fort claque, puis l'écran
  clignote 4 à 12 fois par temps selon l'énergie et l'impact, soit environ 9 à 28 Hz à
  140 BPM. Les flashs et le strobe sont colorés dans l'accord de la scène, pas blancs :
  chaque éclat alterne entre la teinte principale et la complémentaire. Pendant le plein
  strobe, la scène devient une scène de rave : le plateau de
  **lyres en éventail** (`lyres-eventail`) est renforcé par les tirs croisés des coins,
  un burst de rayons et les projecteurs mobiles des bords.
  Le cycle dure 8 temps : 4 temps de strobe plein, 2 temps de creux où seules les
  barres LED strobe, puis 2 temps de reprise. Le budget de flashs et le mode réduit
  restent maîtres : « Sans flashs » ou « Intensité réduite » coupent tout.
- du mouvement de scène de club : caméra de rave (zoom pulsé sur le kick, rotation et
  balayage lents), éventail de lyres qui balaie vite, burst en rotation continue, tirs
  croisés et projecteurs mobiles qui parcourent le cadre ;
- des lasers scan ultra-fins, jusqu'à 36 faisceaux depuis la scène et le plafond, qui
  balaient le cadre, un mur de blinders qui claque sur chaque kick, des coupes glitch
  sur les gros drops et un balayage arc-en-ciel sur les faisceaux.
- le mode réduit reste prioritaire : il garde son vocabulaire calme, même si le profil est
  forcé.

### La transition

Le passage du direct au show programmé (et le retour) n'est pas une coupure : l'image s'ouvre
depuis le noir avec un front lumineux qui balaie l'écran, sur environ 1,5 s.

Le fond, le halo et la poussière sont dessinés en permanence sous la famille de la phrase :
une image montre toujours deux mondes superposés, même quand la scène change.

**Réactions aux moments forts** :

La dérive de teinte est une sinusoïde bornée (période 90 s) et la teinte rendue est
ramenée dans la fenêtre du morceau : elle ne sort jamais du budget de couleur, même après
plusieurs minutes. La brillance d'une scène est la **moyenne** de la courbe aiguë, plus une
somme saturée : les réservoirs de familles sont réellement distincts.

- **drop** : quand une montée se résout sur l'impact, saut de teinte borné à 26°
  (`DROP_HUE_JUMP`), wash complet de projecteurs pendant 6,5 s (`WASH_SPAN_SEC`) et lavage
  blanc bref. Chaque drop reçoit une **signature** tirée de la graine — orientation des
  lyres, geste des barres, motif des blinders, pôle de teinte — donc deux impacts ne se
  ressemblent pas ;
- **montée d'énergie** : quand le morceau prend de l'ampleur, l'intensité augmente et le
  spectacle pulse sur les temps forts ;
- **temps forts** : flashs cadencés, pulsations du noyau lumineux, ondes des anneaux.

Tout cela reste dosé : un flash ne dépasse jamais 80 % d'opacité (`FLASH_CEILING`), et la
cadence suit la musique — un flash par temps fort pendant un drop, un seul par phrase hors
drop. Un impact de montée garde la priorité. Le flash naît sur son déclencheur (latence
nulle) puis monte en 40 ms sur un temps fort, 120 ms sur un drop. Le mode réduit supprime
les flashs, le wash de drop et les variations.

**Synchronisation** : chaque image est rendue à partir de `audio.currentTime`. Aucun état
n'accumule de dérive, donc la position du spectacle est toujours juste, y compris après
seek. La qualité s'adapte d'elle-même (nombre d'éléments réduit sous 52 fps).

**Confort visuel** :

- mode « intensité réduite » (moins d'éléments, mouvements ralentis, aucun flash) ;
- curseur de flashs réglable de 0 à 150 %, avec un plafond d'opacité et une cadence
  musicale (temps forts pendant un drop, une phrase hors drop) ;
- `prefers-reduced-motion` du système est respecté et active automatiquement le mode réduit ;
- deux teintes voisines sont toujours séparées d'au moins ~34°, pour éviter les alternances
  de couleur agressives ;
- les flashs sont suffisamment espacés pour ne pas former de stroboscope ; ce n'est pas une
  garantie, et le mieux reste de les couper si tu y es sensible.

## Développement

L'ordre est important : sans `node_modules`, `bun run typecheck` échoue avec
`TS2688` (types `bun`, `node` et `vite` introuvables). Ce n'est pas une erreur
de code, c'est une précondition.

```bash
bun install             # 1. dépendances front (obligatoire avant typecheck)
uv sync                 # 2. environnement Python (.venv via uv)
bun run typecheck       # 3. types (tsc)
bun run lint            # 4. oxlint (front) + ruff (serveur)
bun run test            # 5. types + tests front + tests serveur
```

Pour lancer uniquement l'API d'analyse :

```bash
uv run uvicorn server.main:app --host 127.0.0.1 --port 8787
```

`bun scripts/check.sh` (ou `bun run check`) enchaîne installation, typecheck,
lint et tests, et s'arrête au premier problème. La mesure de référence
(nombre de tests, durée, versions d'outils) est dans
[`docs/baseline.md`](docs/baseline.md).

Pour le détail des tests, du corpus de référence et du harnais de métriques,
voir [`docs/testing.md`](docs/testing.md).

### Documentation

| document | contenu |
| --- | --- |
| [`docs/baseline.md`](docs/baseline.md) | environnement reproductible et mesures de référence |
| [`docs/testing.md`](docs/testing.md) | tests, corpus de référence, harnais de métriques |
| [`docs/metrics/README.md`](docs/metrics/README.md) | champs des JSON de mesure (`plan`, `render`, `timing`) |
| [`docs/scene-effects-spec.md`](docs/scene-effects-spec.md) | spec des effets, avec statut (ACTIF / CODE MORT / PARTIEL / DIVERGENT) et preuve `fichier:ligne` |
| [`docs/scene-effects-audit.md`](docs/scene-effects-audit.md) | audit de l'état **avant fusion**, scène par scène et règle par règle (historique) |
| [`docs/deezer-queue.md`](docs/deezer-queue.md) | contrat du userscript de file Deezer |
| [`docs/test-harness-report.md`](docs/test-harness-report.md) | rapport du harnais de tests D0–D9 (historique) |
| [`docs/integration-report.md`](docs/integration-report.md) | rapport d'intégration des PR #29, #30 et #31 |

## Tests

```bash
bun run check           # tout : install, typecheck, lint, tests (arrêt au premier échec)
bun run lint            # oxlint (front) + ruff (serveur)
bun run typecheck       # types (tsc)
bun run test            # types + tests front + tests serveur
bun run build           # build de production dans dist/
bun run check:browser   # parcours complet dans un vrai navigateur (Playwright)
bun run check:sync      # synchronisation Show ↔ lecteur, sans lecteur réel
bun run check:dashboard # écran de show + dashboard, de bout en bout
```

Les vérifications navigateur (`check:*`) exigent un environnement préparé :

```bash
uv sync                                 # crée .venv (le serveur est lancé via .venv/bin/uvicorn)
bun add -D playwright                   # client Playwright
bunx playwright install chromium        # navigateur
bun run build                           # l'API sert dist/ pour ce type de test
```

Les tests couvrent le cœur pur (courbes, scènes, couleurs, rendu déterministe), le serveur
(détection de format, limites, cycle d'analyse, suppression de session) et un parcours
navigateur réel : dépôt, analyse, lancement, pause/reprise, mode réduit, redémarrage, retour
au dépôt, absence d'erreur console.

### Tester la synchronisation sans lecteur réel

`bun run check:sync` fabrique un faux `playerctl` (`tests/support/fake_playerctl.py`, piloté par
`tests/support/fake_player.py`) qui joue un morceau de 12 s dont on choisit la position et le titre.
Le serveur est lancé avec ce faux binaire en tête de `PATH`, puis le test dépose le fichier
correspondant et vérifie, via l'overlay de debug :

1. que le show démarre à la position du lecteur (écart mesuré, pas une fourchette) ;
2. qu'un **recul** de 5 s est suivi par le show ;
3. qu'une **avance** de 5 s est suivie aussi ;
4. qu'un changement de morceau ramène en Live ;
5. que l'écart résiduel après recadrage reste sous 300 ms.

Deux régressions sont couvertes par ces tests :

- **l'horloge** : la position du lecteur doit être extrapolée avec `Date.now()` (epoch,
  comme le serveur), jamais `performance.now()`. Mélanger les deux ramenait la position à
  0 et rebouclait le show sur la même scène ;
- **la latence de lecture** : `playerctl` met du temps à répondre, donc le serveur
  horodate la position au milieu du sous-processus (`position_read_at`) au lieu de la fin
  de tous les appels. Sans ça, le show perdait à chaque resync la durée de lecture du
  binaire (~0,5 s avec un faux lent).


## Structure du dépôt

```
index.html              écran de show : la toile, rien d'autre
dashboard.html          tableau de bord : tout ce qui se règle et se lit
effets.html             studio d'effets : galerie, scène et projection sur le show
src/
  main.ts               démarrage
  types.ts              schéma de l'analyse et réglages de rendu
  core/
    series.ts           échantillonnage et aides numériques (purs)
    view.ts             accès à l'état musical à un instant donné
    show.ts             composition des scènes (palettes, familles)
    effects.ts          inventaire des effets et timeline synthétique du studio
    families/           les trente-deux familles d'effets, groupées par provenance
      concert-rig.ts    structure, lyres, barres LED et blinders
      index.ts          agrégation de la table des familles
    render.ts           rendu d'une image complète
    color.ts            HSL → RGB
    api.ts              client HTTP de l'API
    nowPlaying.ts       détection du morceau joué par un lecteur externe (pur)
    liveAudio.ts        caractéristiques audio live (normalisation, lissage)
    playback.ts         position du lecteur, dérive, corrélation (purs)
    debug.ts            journal de debug partagé (console + overlay)
  shared/
    control.ts          protocole show ↔ dashboard/studio (WebSocket + BroadcastChannel)
  browser/
    app.ts              orchestration (dépôt, analyse, show, raccourcis)
    app-drop.ts         dépôt du fichier et écran d'analyse
    app-resolve.ts      récupération d'un morceau par titre (Deezer)
    app-live.ts         mode live : lecteur externe et file multi-source
    app-sync.ts         calage sur la position du lecteur, repli en live
    app-show.ts         lancement du show, bascule vers le rendu analysé
    app-control.ts      réglages poussés depuis le dashboard, overlay de debug
    app-effects.ts      effet forcé depuis le studio, par-dessus le show
    app-loop.ts         boucle de rendu, qualité adaptative, HUD
    audio.ts            lecture et position musicale
    format.ts           formatage court partagé (overlay, rendu)
    ui.ts               accès DOM
  styles/               base, dépôt, HUD
  dashboard/            tableau de bord (page, graphiques, styles)
  effects/              studio d'effets (page, galerie, styles)
server/
  config.py             réglages lus dans l'environnement
  relay.py              relais WebSocket du contrôle entre appareils
  sniff.py              détection du format réel par octets
  analysis.py           moteur librosa (décodage, courbes, rythme, section, montées)
  analysis_cache.py     cache persistant des analyses (clé morceau + version d'analyseur)
  audio_capture.py      capture audio système locale (PipeWire/PulseAudio)
  store.py              sessions et travaux d'analyse
  main.py               API FastAPI
  mpris.py              détection des lecteurs via MPRIS / playerctl
  playback_position.py  position de lecture des lecteurs externes
  queue/                file multi-source : modèles, sélection, préchargement, Deezer
  retrieve/             récupération d'un morceau : provider Deezer (streamrip), cache, validation
tests/                  tests front & serveur (unit/), vérification navigateur (e2e/),
                        faux lecteur et fixtures (support/)
scripts/                démarrage dev, lancement des tests, mesures et outillage d'analyse
bench/                  chronométrage manuel d'une analyse, hors API
userscripts/            file Deezer (script navigateur)
docs/                   spec et audit des effets, harnais de tests, mesures, rapports
```

## Variables d'environnement

| variable | défaut | rôle |
| --- | --- | --- |
| `SESSION_DIR` | `/tmp/night-light-sessions` | répertoire des sessions (fichiers audio de lecture) |
| `CACHE_DIR` | `~/.local/share/night-light/cache` | cache persistant des morceaux récupérés (survit au redémarrage) |
| `MAX_FILE_MB` | `40` | taille d'envoi maximale |
| `MAX_DURATION_SEC` | `900` | durée de morceau maximale |
| `ANALYZE_TIMEOUT_SEC` | `240` | limite dure d'une analyse (le process est interrompu et l'erreur `timeout` renvoyée) |
| `SESSION_TTL_SEC` | `1800` | durée de vie d'une session inactive |
| `DEEZER_ARL` | *(vide)* | cookie ARL Deezer pour la récupération d'un morceau (vide : récupération désactivée) |
| `API_PORT` | `8787` | port de l'API |
| `WEB_PORT` | `5173` | port de l'interface |
| `NIGHTLIGHT_LAN` | *(vide)* | `1` publie l'interface sur le réseau local (mode `dev:lan`, téléphone) |
| `ALLOW_NETWORK` | *(vide)* | lève le refus de démarrer sur une adresse non locale (voir Sécurité) |

## Le tableau de bord (`/dashboard`)

Deux pages, deux rôles. L'écran de show (`/`) n'est plus qu'une toile ; tout ce qui se lit et
se règle vit sur `/dashboard`, ouvert sur un autre écran :

```bash
bun run dev        # puis https://nightlight.localhost/dashboard
```

| Sur l'écran de show | Sur le dashboard |
| --- | --- |
| le canvas, en plein écran | mode, capture, positions, écart au son |
| aucun bouton, aucun panneau | spectre live, niveaux, courbes de 60 s |
| raccourcis `D` `S` `Échap` `F` | dépôt de fichier, recherche par titre |
| | intensité, flashs, réduit, sans flashs |
| | latence (+ presets filaire / Bluetooth, calage) |
| | forcer Live / Show, couper la capture, overlay |

### Comment les pages se parlent

Deux transports dans `src/shared/control.ts` :

- un **WebSocket** vers `/api/control`, relayé par le serveur (`server/relay.py`) : c'est lui
  qui traverse les appareils, par exemple un téléphone qui pilote un écran de show sur le PC ;
- `BroadcastChannel`, conservé comme repli instantané quand les deux pages vivent dans le
  même navigateur et que le serveur est injoignable.

L'émission choisit un seul transport (le WebSocket dès qu'il est ouvert) pour ne pas doubler
les commandes. Le show **publie** son état complet 5 fois par seconde ; le dashboard et le
studio **envoient** des commandes (`set-latency`, `set-settings`, `capture`, `force-live`,
`force-show`, `debug-overlay`, `analysis-ready`, `set-effect`…).

Aucun état applicatif n'est conservé sur le serveur : le relais diffuse les messages tels
quels et n'entend jamais l'expéditeur. Le protocole est versionné — deux versions différentes
s'ignorent au lieu de se comprendre de travers.

Le dashboard fait lui-même l'analyse : il dépose ou résout le morceau, puis transmet l'analyse
à l'écran de show, qui se charge du calage sur le lecteur. Le fichier audio ne traverse donc
jamais le canal.

### Le studio d'effets (`/effets.html`)

Le studio découvre automatiquement toutes les familles du moteur (`src/core/effects.ts`) et
permet d'en projeter une sur l'écran de show, avec ses réglages : palette, tempo, énergie,
basses, aigus, vitesse, rôle, humeur, graine, intensité, flashs.

Le bouton **Projeter** (raccourci `P`) envoie l'effet à l'écran de projection. Il fonctionne
depuis un téléphone comme depuis le PC : l'émission passe par le relais WebSocket. Tant qu'un
effet est projeté, le show reste en mode kiosque et rend une timeline synthétique, même sans
morceau chargé. Un second clic rend la main au spectacle en cours.

Pour ouvrir le studio depuis un téléphone sur le même réseau :

```bash
bun run dev:lan     # Portless reste actif, et affiche http://<ip-du-pc>:<port>/effets.html
```

Portless continue de servir `https://nightlight.localhost` sur le PC ; Vite écoute en plus sur
toutes les interfaces et le script affiche l'URL LAN avec le port réellement choisi par
Portless. L'API reste sur `127.0.0.1` : seul le proxy Vite est exposé au réseau local, et il
relaie `/api` ainsi que le WebSocket de contrôle.

### L'écran de show sait vivre seul

Tant qu'aucun dashboard ne lui parle, `/` reste une application normale (dépôt, analyse,
show) : les tests et l'usage à un seul écran continuent de fonctionner. Dès qu'un dashboard se
manifeste, la classe `kiosk` masque toute l'interface ; si le dashboard disparaît plus de 3 s,
elle est retirée et l'écran redevient utilisable. Pas de piège de l'écran noir.

## Synchronisation Show / lecture externe

### Prérequis pour la position de lecture

Le show automatiquement synchronisé utilise **MPRIS** pour connaître le morceau en cours
et la position du lecteur. Options :

1. **playerctl** (recommandé, le serveur l'utilise comme repli), installé sur le système.
2. **Un lecteur MPRIS compatible** (Spotify, VLC, MPD avec `mpd-mpris`, navigateurs Chromium
   modernes sous Linux…).

```bash
# Debian/Ubuntu
pkexec apt install playerctl
```

Si aucune position n'est disponible, Night Light bascule automatiquement sur un repli par
corrélation d'énergie (tour de garde supplémentaire), puis revient en mode Live si le score
est insuffisant.

### Calage de la latence Offline

Dans le dock **Analyse**, le réglage **Latence (ms)** (-500 à +1000, pas de 10 ms) compense
la différence entre le signal audio et le rendu visuel :

- **Filaire** : preset 0 ms.
- **Bluetooth** : preset +200 ms.
- **Bouton « Caler »** : pendant un show synchronisé, tape quand tu entends le beat ; la
  valeur s'ajuste approximativement. Deux taps supplémentaires affineraient en production.

Les valeurs sont persistées dans `localStorage` (`night-light-latency`).

### Pourquoi certains morceaux n'ont presque pas de drops

Les drops viennent des **montées** de l'analyse : `server/analysis.py` (`detect_builds`) valide une
montée seulement si elle gagne **≥ 18 %** d'énergie sur **≥ 2 s**. Un morceau fort d'un bout à
l'autre — rap masterisé, electro compressée — ne contient presque aucune montée, donc aucun
drop : le spectacle ne vivait plus que sur les changements de scène.

Deux conséquences, et un réglage :

- ce n'est **pas** un problème de synchronisation ni d'encodage (vérifié : WAV, MP3 128 kbps et
  FLAC donnent exactement les mêmes montées) ;
- le log d'analyse affiche le chiffre (`analyse terminée {..., temps: 394, montees: 1, ...}`) ;
- **pulsage de secours** : quand l'analyse trouve **2 montées ou moins**, le rendu pulse sur les
  temps forts eux-mêmes (`beatDrive` dans `src/core/render.ts`), à 60 % de l'intensité d'un vrai
  drop et dosé par l'énergie locale. Un morceau dynamique ne voit rien changer, un morceau plat
  respire au rythme du beat.

### Pourquoi le show ne s'éteint jamais

L'analyse normalise l'énergie en échelle logarithmique — le 10e centile tombe à 0
— ce qui écrase les couplets. Un passage audible se retrouvait à 0,05, et comme
l'alpha de chaque famille vaut `0,05 + 0,32 × énergie`, l'écran devenait **noir en
pleine musique**.

Le rendu pose donc un plancher visuel (`ENERGY_FLOOR = 0.26`, `visibleEnergy`)
exclusivement sur ce qu'il dessine, jamais sur les données d'analyse : un couplet
reste plus calme qu'un refrain (0,26 contre 0,95 d'énergie) mais rien ne
disparaît. Les gardes de montées, de sections et de drops continuent de voir
l'énergie réelle.

### Modération des flashs
Trop de flashs fatiguent une salle autant qu'un écran. Deux gardes, toutes deux des fonctions
pures du temps musical (donc déterministes : après une pause ou un saut, la même image sort) :

- **cadence** (`FLASH_MIN_GAP = 1.6 s`) : un flash de temps fort sur `n` seulement, `n` étant
  calculé pour que l'intervalle dépasse toujours 1,6 s — 4 temps forts à 130 BPM, 2 à 60 BPM ;
- **lavage blanc** : seul un vrai drop de l'analyse blanchit l'écran. Le pulsage de secours
  éclaire la scène, il ne flashe jamais plein écran.

Un drop de montée garde sa priorité sur la cadence : il est rare, et c'est justement le moment
que le spectacle doit montrer.

### Des pulses en accord avec la musique

Trop de pulses fatiguent, mais les supprimer partout appauvrit le show. Le vrai réglage est de
**ne célébrer que les temps forts qui portent quelque chose** : `beatStrength` (dans
`src/core/render.ts`) croise trois informations de l'analyse —

- le temps fort lui-même (`beatPulse`) ;
- la bande **30-150 Hz** à cet instant : pas de basse, pas de pulse. Une charley ou un temps
  mort ne déclenche plus rien ;
- l'énergie du passage et celle de la section.

Résultat : fort sur un kick dans un passage soutenu, quasi muet dans un couplet calme, et
strictement rien sur un temps fort sans basse. Tout ce qui pilote l'image (familles, flashs,
montées, intensité) passe par cette valeur, donc le show respire avec la musique au lieu de la
couvrir.

### Overlay de debug

Touche **D** affiche / masque l'overlay avec : mode actif, source de position, position show,
latence appliquée et état de la capture.

## Debug : voir ce qu'il se passe en direct

Deux sorties complémentaires, pensées pour diagnostiquer une soirée sans deviner.

### Overlay à l'écran — touche `D`

Affiche et masque un panneau en haut à droite. Il se rafraîchit deux fois par
seconde et contient :

| Ligne | Contenu |
| --- | --- |
| `mode` | `LIVE`, `SYNCING`, `SHOW_SYNCED`, `SHOW_LOCAL`, `PAUSED`, `LOST` |
| `capture` | état du flux SSE (`ouvert`, `fermé`, `erreur`), nombre de messages reçus, débit en messages/s, âge du dernier message |
| `capture état` | état remonté par `parec` (`active`, `silent`, `error`), moniteur audio utilisé, erreur éventuelle |
| `audio brut` | `rms`, énergie, basses, médiums, aigus, transitoire tels que reçus du serveur |
| `audio lissé` | les mêmes valeurs après lissage exponentiel |
| `rendu live` / `rendu show` | fps mesurés, palier de qualité, nombre d'images |
| `sync …` | source, morceau attendu vs morceau lu, position lecteur, position show, écart en ms, latence appliquée, tentatives, verdict |
| `journal` | les derniers événements horodatés |

Le journal limite les lignes de routine (valeurs qui se répètent) à six pour que
les vrais événements — changement de morceau, recalage, erreur — restent lisibles.

### Console du navigateur

Chaque événement écrit une ligne horodatée et catégorisée :

```
[live]    11:04:10.212 mode live démarré · capture du son du PC ouverte
[capture] 11:04:10.270 état de la capture → active {"source":"…monitor","rms":"0.0000"}
[analyse] 11:04:10.403 phase « En file d'attente » {"progression":"0 %"}
[sync]    11:04:10.273 lecteur scruté {"source":"détecté","titre":"Karma","ambigue":false}
[sync]    11:04:29.350 écart important · recalage direct du show {"ecartMs":1810}
[ERREUR]  11:04:30.001 position de lecture injoignable pendant la resynchronisation
```

Catégories : `boot`, `capture`, `analyse`, `sync`, `live`, `show`, `ERREUR`.
Les valeurs qui se répètent (caractéristiques audio, resynchronisations OK,
scrutation du lecteur) sont naturellement espacées dans le temps pour ne pas
noyer la console.

Les valeurs de l'overlay et les lignes de console sont écrites par
[`src/core/debug.ts`](./src/core/debug.ts) (`dbgLog`, `dbgThrottled`).

## Licence

[MIT](./LICENSE).
