# Changelog

Toutes les évolutions notables de ce projet sont consignées ici.
Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le
projet adhère à [SemVer](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté

- **Processus d'analyse persistant** : un worker préchauffé au démarrage (imports
  + JIT numba) réutilisé entre les morceaux ; une annulation le tue et en relance
  un préchauffé en arrière-plan. L'analyse complète passe d'environ 5 s à froid
  par processus à ~1,8 s à chaud.
- **Phases d'analyse** : durées détaillées (démarrage worker, décodage,
  rééchantillonnage, onset, beat_track, onsets, stft, bandes/rms, courbes,
  montées, sérialisation) publiées dans `timings.analysisPhases` et affichées
  dans le dashboard.
- **Analyse en 2 passes** : une passe rapide sur une fenêtre de 45 s autour de
  la position MPRIS publie une analyse partielle (`coverage`) en moins d'une
  seconde après le téléchargement, puis l'analyse complète remplace le plan en
  fin de scène, avec la même graine. Seule l'analyse finale entre dans le cache.
  Le front rend en mode live hors de la zone couverte et extrapole la grille de
  beats ; un tempo partiel au double/halve est réaligné sur le tempo final à la
  scène suivante.
- **Fondu enchaîné** à l'entrée d'un show synchronisé : le live et le rendu
  analysé sont dessinés hors écran puis composités en ease-in-out, sans frame
  noir. La bascule vise le prochain temps fort (au plus un temps) ou l'impact
  d'une montée dans les 4 s ; elle se raccourcit à 0,6 s si la qualité passe
  sous 0,5. L'ancien fondu noir reste disponible dans le dashboard.
- **Détection MPRIS temps réel** : `playerctl --follow metadata` remplace le
  polling 1 s, avec redémarrage automatique et polling de secours. Les
  changements partent en SSE (`/api/now-playing/stream`), le front ne sonde le
  lecteur que si le flux est coupé.
- **Calage plus rapide** : `tryAutoSynced` essaie immédiatement puis avec des
  intervalles croissants (250 ms, 500 ms, 1 s…), au lieu d'attendre 2 s entre
  chaque tentative.
- **Analyse annulable** : le process d'analyse est tué quand MPRIS passe à un
  autre morceau, sauf au-delà de 80 % de progression pour alimenter le cache.
- **Chronologie du morceau** : le serveur mesure recherche, téléchargement,
  analyse et cache ; l'écran de show ajoute le calage et le premier frame. Le
  dashboard affiche la chaîne détecté → trouvé → téléchargé → analysé → calé →
  premier frame pour le morceau en cours.
- **Cache d'analyse** : une réécoute du même morceau (même clé Deezer et même
  `ANALYZER_VERSION`) ne relance plus librosa. Écriture atomique, invalidation
  des JSON corrompus et purge LRU via `ANALYSIS_CACHE_MAX_MB`.
- Tableau de bord complet : analyse du morceau en cours (courbes d'énergie et de
  bandes, sections, temps forts, montées, curseur du show), VU-mètres, progression,
  pulsation au tempo, section active, prochains événements, états capture et rendu.
  Le dashboard réclame l'**analyse complète** à l'écran de show (une seule fois,
  via le canal de contrôle) car l'état publié en continu n'en porte qu'un résumé.
- Détection de la **structure répétitive** du morceau : chaque section reçoit un
  groupe et un rôle (intro, couplet, refrain, pont, outro). Les passages d'un même
  groupe se répètent à l'identique dans le show (même famille visuelle et même
  teinte), et le refrain force l'énergie et la complémentaire. Le HUD affiche ce
  rôle.
- **Métrique dominante** (`meter`) : une estimation par autocorrélation de
  l'accentuation distingue le ternaire (3/4) du binaire (4/4), avec repli à 4 en
  cas de confiance faible. La grille du show suit cette métrique au lieu de
  supposer 4/4.
- **Subdivision du médium** : courbes `midLow` (150–600 Hz) et `midHigh`
  (600–2500 Hz) en plus de `mid`, pour séparer le corps du bas-médium de la
  présence des caisses claires.
- **Morceaux continus** : quand aucun matériau ne revient (jazz, ambient, métal
  progressif), le découpage passe par une courbe de nouveauté sur
  l'auto-similarité MFCC et les sections reçoivent des rôles de progression
  (exposition, développement, climax, résolution).

### Retiré

- **Découpage du morceau en sections (couplet/refrain)** : la détection coûtait
  cher dans le budget d'analyse et multipliait les fausses frontières (refrains
  enchaînés). Le morceau est désormais décrit par une **section unique**, de 0 à
  la fin, étiquetée d'après son énergie ; le spectacle suit l'énergie, les
  montées et les temps forts. `server/structure.py` et la phase « Structure
  musicale » disparaissent.

### Ajouté

- **Éventail du plafond** : l'éventail de faisceaux peut désormais partir du haut
  de l'écran, en miroir de celui du bas. Les deux s'allument ensemble ou l'un
  sans l'autre, au fil du morceau.

### Modifié

- **`ANALYZE_TIMEOUT_SEC` est désormais appliqué** : l'analyse tourne dans un
  process dédié et une limite dure tue le worker, avec une erreur `timeout`
  explicite au lieu d'un blocage silencieux.
- Résolution des morceaux suivie comme une **pile** et non une file : le morceau
  courant est téléchargé et analysé en premier ; les morceaux sautés sont
  téléchargés ensuite pour rester en cache, mais sans être affichés.
- Le schéma d'analyse passe en **version 2** (sections enrichies) ; la détection
  de structure ajoute une phase d'analyse.
- La structure couplet/refrain est calculée **en local avec librosa**, sur le
  spectre et les temps forts déjà obtenus (chroma + MFCC par temps fort). La
  dépendance `msaf` est retirée, avec ses sous-dépendances (matplotlib, pandas…) :
  l'analyse complète retombe de ~30 s à ~4 s sur un morceau de 2 min.

### Corrigé

- **Drop après un cut** : la fin d'une montée peut désormais enjamber un silence
  franc de 150 à 450 ms et se caler sur le premier onset énergique qui suit le
  creux, au lieu de rester sur le dernier bruit du riser.
- **Détection du morceau joué** : un lecteur qui n'expose pas l'artiste
  (fichiers locaux, lecteurs partiels) était ignoré, l'indicateur « Lecteur
  détecté » restait caché et la résolution automatique ne partait jamais.
- La conversion des champs du suivi du lecteur (`position_sec`, `duration_sec`,
  `updated_at`) est corrigée : le show reprend à la position du lecteur et la
  durée est transmise à la résolution.
- Une résolution automatique qui échoue (morceau absent du catalogue, Deezer non
  configuré) ne remplace plus le show en cours par l'écran d'erreur.
- **Éventail de faisceaux** : la source était posée 2 % sous le bord bas de
  l'écran, donc on ne la voyait jamais s'allumer, et ses rayons les plus ouverts
  partaient vers le bas, hors cadre — parfois il n'en restait qu'un. La source
  est ramenée dans le cadre et l'ouverture est bornée pour que tous les rayons
  entrent.

## [2.0.0]

### Ajouté

- Analyse audio serveur (librosa) : tempo, temps forts, attaques, bandes de
  fréquences, énergie, sections et montées.
- Vingt-cinq familles visuelles tournantes, sur trois échelles de renouvellement
  (phrase, variation, dérive).
- Surface de fumée pour des faisceaux diffus, sans effondrement du framerate.
- Palette par morceau, bascule sur la complémentaire aux moments forts.
- Tableau de bord séparé (`/dashboard`), relié à l'écran de show par
  `BroadcastChannel`.
- Synchronisation sur un lecteur externe via MPRIS (`playerctl`), avec repli par
  corrélation d'énergie.
- Capture audio système (PipeWire/PulseAudio) et rendu en direct.
- Récupération d'un morceau par titre/artiste via Deezer (streamrip, opt-in par
  `DEEZER_ARL`).
- Overlay de debug (touche `D`) et journal console catégorisé.

### Modifié

- Le show est une fonction du temps musical (`audio.currentTime`) : aucune
  dérive, y compris après pause, reprise ou saut.

[Non publié]: https://github.com/MattiaPARRINELLO/night-light-v2/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/MattiaPARRINELLO/night-light-v2/releases/tag/v2.0.0
