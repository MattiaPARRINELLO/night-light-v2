# File Deezer (userscript)

`userscripts/deezer-queue.user.js` (version 1.0.0) envoie le morceau courant et
les deux suivants à `POST /api/deezer-queue` sur `127.0.0.1:8787`.

- Les noms exacts des objets internes Deezer (`dzPlayer`, méthodes de file) ne
  sont **pas vérifiés** : le script sonde plusieurs candidats et journalise les
  clés `window` trouvées dans la console.
- Si aucune file n'est lisible, il envoie l'URL : le serveur retombe sur l'API
  publique Deezer pour une playlist ou un album.
- Flow et radio ne déclenchent aucun préchargement.

Le payload accepté est documenté dans l'en-tête du script. Spotify a été retiré
volontairement : la file vient du userscript Deezer ou reste en MPRIS seul.
