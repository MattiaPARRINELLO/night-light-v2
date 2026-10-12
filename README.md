# Night Light — light show musical

Application **personnelle** (une seule personne, aucune authentification) : tu déposes un
morceau, le serveur l'analyse avec librosa, et le navigateur joue un spectacle lumineux
synchronisé sur la musique.

```
morceau (glisser-déposer)
   → serveur Python : décodage, bandes, tempo, temps forts, sections, montées
   → interface (Canvas 2D) : faisceaux, tunnel, particules, vagues, grille, anneaux
        pilotés par la position réelle de lecture (audio.currentTime)
```

Ce n'est **pas** un visualiseur qui réagit au volume : tout le spectacle est calculé à
partir de l'analyse, et l'image est une fonction du temps musical. Après une pause, une
reprise ou un retour en arrière, le spectacle reprend exactement là où la musique en est.

---

## Démarrer

```bash
bun install            # dépendances de l'interface (Vite)
bun run dev            # API + interface via Portless → https://nightlight.localhost
```

`bun run dev` lance deux processus :

- l'API d'analyse (`uvicorn`, **127.0.0.1 uniquement** — elle n'est pas exposée sur le réseau) ;
- l'interface (`vite`) publiée par Portless sur `https://nightlight.localhost`, qui relaie `/api` vers l'API.

Sans Portless : `bun run api` (API) et `bunx vite` (interface) séparément, puis ouvrir
l'adresse affichée par Vite.

## Utiliser

1. Ouvre l'application : plein écran, zone **« Dépose ta musique ici »** (glisser-déposer
   ou bouton « Choisir un fichier »).
2. Formats acceptés : **MP3, WAV, OGG, FLAC, M4A/AAC, AIFF, WebM** — vérifiés d'après les
   octets du fichier, pas d'après son extension (un MP3 renommé `.wav` est reconnu comme MP3).
3. L'écran d'analyse affiche le nom, la durée, la progression réelle (envoi puis phases
   d'analyse) et, à la fin, le bouton **« Lancer le show »**.
4. Pendant le show : lecture/pause (`Espace`), recommencer (`R`), plein écran (`F`),
   volume (`↑`/`↓`), position (`←`/`→`), intensité, flashs, intensité réduite, sans flashs,
   retour à l'écran de dépôt.
5. Tu peux relancer le show autant de fois que tu veux : tant que la session vit, l'analyse
   et le fichier audio sont gardés côté serveur, il n'y a rien à recalculer.

## Confidentialité et sécurité

- Le fichier part de ton navigateur vers **ton serveur local**, et c'est indiqué sur
  l'écran de dépôt.
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
  par variables d'environnement (voir `.env.example`).

**N'expose pas ce serveur à Internet** : il n'a pas d'authentification.

## Ce que l'analyse produit

Réellement calculé par librosa sur les échantillons décodés (22 050 Hz, STFT 2048/hop 512) :

| donnée | méthode |
| --- | --- |
| tempo, temps forts | `onset_strength` + `beat_track` (recherche de phase) |
| attaques | `onset_detect`, corrigé du retard de groupe de la STFT |
| basses / médiums / aigus | énergie des bandes 30–150, 150–2000, 2000–10 000 Hz, lissée puis normalisée |
| énergie globale | RMS + bandes, normalisation logarithmique (reste lisible dans les passages modérés) |
| sections | regroupement agglomératif de MFCC + chroma, puis étiquetage calme/montée/intense/descente/silence |
| montées | dérivée de la courbe d'énergie, filtrée sur l'amplitude gagnée |

Toutes les courbes sont envoyées en points `[secondes, 0..1]` à 20 Hz — compacts et
directement échantillonnables depuis le navigateur.

### Limites connues

- **M4A/AAC** : libsndfile ne les ouvre pas toujours ; le serveur les décode alors via
  `ffmpeg`. Si `ffmpeg` est absent, ces formats sont refusés avec un message clair.
- **Tempo** : la détection de battement reste une estimation. Sur des morceaux sans
  percussion marquée (ambient), elle peut désigner la moitié ou le double du tempo ressenti.
  Le spectacle s'appuie donc aussi sur les courbes d'énergie et de bandes, pas seulement sur
  les temps forts.
- **Sections** : un regroupement automatique, pas une annotation musicale. Il donne des
  ambiances cohérentes, pas une structure « couplet / refrain ».
- La lecture dans le navigateur dépend des codecs du navigateur : si un morceau analysé
  n'est pas lisible, l'application le dit et propose un format plus sûr (WAV, MP3).

## Le spectacle

Dix familles visuelles tournantes : faisceaux, tunnel, particules, vagues, grille,
anneaux, volets, barres, spirale, projecteurs.

Trois échelles de renouvellement se superposent, pour que l'écran ne tourne jamais en
boucle :

| échelle | durée | ce qui change |
| --- | --- | --- |
| **phrase** | 5-8 s | famille principale, palette, humeur (calme / pulsé / explosif / aérien / sombre) |
| **variation** | milieu de chaque phrase | une seconde famille surgit brièvement, avec sa propre teinte |
| **dérive** | en continu | la teinte glisse de 14°/s, la saturation et l'étalement respirent |

Deux couches sont visibles en permanence : la famille de la phrase et une couche de fond
discrète, de sorte qu'une image montre toujours deux mondes superposés.

**Réactions aux moments forts** :

- **drop** : quand une montée se résout sur l'impact, saut de teinte de 70°, sur-couche
  visuelle et flash blanc pendant ~2,5 s ;
- **montée d'énergie** : quand le morceau prend de l'ampleur, l'intensité augmente et le
  spectacle pulse sur les temps forts ;
- **temps forts** : flashs cadencés, pulsations du noyau lumineux, ondes des anneaux.

Tout cela est plafonné : un flash ne dépasse jamais 40 % d'opacité, deux flashs sont
séparés d'au moins 0,14 s, et le mode réduit supprime les flashs, la sur-couche de drop
et les variations.

**Synchronisation** : chaque image est rendue à partir de `audio.currentTime`. Aucun état
n'accumule de dérive, donc la position du spectacle est toujours juste, y compris après
seek. La qualité s'adapte d'elle-même (nombre d'éléments réduit sous 52 fps).

**Confort visuel** :

- mode « intensité réduite » (moins d'éléments, mouvements ralentis, aucun flash) ;
- curseur de flashs réglable de 0 à 150 %, avec un plafond d'opacité et un espacement
  minimal entre deux flashs ;
- `prefers-reduced-motion` du système est respecté et active automatiquement le mode réduit ;
- deux teintes voisines sont toujours séparées d'au moins ~34°, pour éviter les alternances
  de couleur agressives ;
- les flashs sont suffisamment espacés pour ne pas former de stroboscope ; ce n'est pas une
  garantie, et le mieux reste de les couper si tu y es sensible.

## Vérifier

```bash
bun run test            # types (tsc) + tests front + tests serveur
bun run check:browser   # parcours complet dans un vrai navigateur (Playwright)
bunx vite build         # build de production dans dist/
```

Les tests couvrent le cœur pur (courbes, scènes, couleurs, rendu déterministe), le serveur
(détection de format, limites, cycle d'analyse, suppression de session) et un parcours
navigateur réel : dépôt, analyse, lancement, pause/reprise, mode réduit, redémarrage, retour
au dépôt, absence d'erreur console.

## Structure

```
index.html              interface (écrans dépôt / analyse / erreur / show)
src/
  main.ts               démarrage
  types.ts              schéma de l'analyse et réglages de rendu
  core/
    series.ts           échantillonnage et aides numériques (purs)
    view.ts             accès à l'état musical à un instant donné
    show.ts             composition des scènes (palettes, familles)
    families.ts         les six familles d'effets
    render.ts           rendu d'une image complète
    color.ts            HSL → RGB
    api.ts              client HTTP de l'API
  browser/
    app.ts              orchestration (dépôt, analyse, show, raccourcis)
    audio.ts            lecture et position musicale
    ui.ts               accès DOM
  styles/               base, dépôt, commandes
server/
  config.py             réglages lus dans l'environnement
  sniff.py              détection du format réel par octets
  analysis.py           moteur librosa (décodage, courbes, rythme, sections, montées)
  store.py              sessions et travaux d'analyse
  main.py               API FastAPI
tests/                  tests front, tests serveur, vérification navigateur
scripts/                démarrage dev et lancement des tests
```

## Variables d'environnement

| variable | défaut | rôle |
| --- | --- | --- |
| `SESSION_DIR` | `/tmp/night-light-sessions` | répertoire des sessions (fichiers audio de lecture) |
| `MAX_FILE_MB` | `40` | taille d'envoi maximale |
| `MAX_DURATION_SEC` | `900` | durée de morceau maximale |
| `ANALYZE_TIMEOUT_SEC` | `240` | délai d'analyse |
| `SESSION_TTL_SEC` | `1800` | durée de vie d'une session inactive |
| `API_PORT` | `8787` | port de l'API |
| `WEB_PORT` | `5173` | port de l'interface |
