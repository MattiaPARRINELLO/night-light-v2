// ==UserScript==
// @name         Night Light — file Deezer
// @namespace    https://github.com/MattiaPARRINELLO/night-light-v2
// @version      1.0.0
// @description  Envoie le morceau courant et les 2 suivants de Deezer à Night Light.
// @match        https://www.deezer.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

/*
 * État de l'investigation : les noms exacts des objets internes du lecteur web
 * Deezer ne sont PAS vérifiés ici (aucune session Deezer instrumentée). Le
 * script sonde donc plusieurs candidats et journalise les clés trouvées.
 * Payload attendu par POST /api/deezer-queue :
 *
 * {
 *   "current": {"deezerId":"3135561","title":"Something About Us","artist":"Daft Punk","durationMs":232000},
 *   "next": [
 *     {"deezerId":"10284907","title":"Genesis","artist":"Justice","durationMs":234000}
 *   ],
 *   "checkedAt": 1790000000,
 *   "note": "dzPlayer.getQueue()",
 *   "resolutionMethod": "deezer_id"
 * }
 *
 * Si aucun objet de file n'est trouvé, le script envoie l'URL : le serveur
 * retombe alors sur l'API publique Deezer pour une playlist ou un album.
 * Flow/radio : aucun préchargement n'est envoyé.
 */

(() => {
  "use strict";

  const VERSION = "1.0.0";
  const ENDPOINT = "http://127.0.0.1:8787/api/deezer-queue";
  const CANDIDATES = ["dzPlayer", "deezerPlayer", "DZPlayer", "player", "dzPlayerInstance"];
  const QUEUE_GETTERS = ["getQueue", "getQueueTracks", "getPlayingQueue", "getNextTracks", "getTracks"];
  const CURRENT_GETTERS = ["getCurrentTrack", "getPlayingTrack", "getCurrentSong"];
  let lastPayload = "";

  function log(...args) {
    console.info(`[Night Light Deezer ${VERSION}]`, ...args);
  }

  function asTrack(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = raw.id ?? raw.trackId ?? raw.SNG_ID ?? raw.songId;
    const title = raw.title ?? raw.SNG_TITLE ?? raw.name ?? raw.trackTitle;
    const artist =
      raw.artist?.name ?? raw.artistName ?? raw.ART_NAME ?? raw.artist ?? raw.artists?.[0]?.name;
    const duration =
      raw.duration ?? raw.DURATION ?? raw.durationMs ?? raw.duration_ms ?? raw.trackDuration;
    if (!title) return null;
    const durationMs =
      duration == null ? null : Number(duration) > 10000 ? Number(duration) : Math.round(Number(duration) * 1000);
    return {
      deezerId: id == null ? null : String(id),
      title: String(title),
      artist: String(artist ?? ""),
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
    };
  }

  function firstArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      for (const key of ["tracks", "data", "songs", "items", "list"]) {
        if (Array.isArray(value[key])) return value[key];
      }
    }
    return [];
  }

  function probePlayer() {
    for (const name of CANDIDATES) {
      const value = window[name];
      if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
      for (const getter of QUEUE_GETTERS) {
        if (typeof value[getter] !== "function") continue;
        try {
          const raw = value[getter]();
          const tracks = firstArray(raw).map(asTrack).filter(Boolean);
          if (tracks.length > 0) return { tracks, method: `${name}.${getter}()` };
        } catch {
          // La file interne peut exiger un état de lecture : on continue.
        }
      }
    }
    return null;
  }

  function probeCurrent() {
    for (const name of CANDIDATES) {
      const value = window[name];
      if (!value || typeof value !== "object") continue;
      for (const getter of CURRENT_GETTERS) {
        if (typeof value[getter] !== "function") continue;
        try {
          const track = asTrack(value[getter]());
          if (track) return track;
        } catch {
          // ignore
        }
      }
    }
    return null;
  }

  function isFlowOrRadio() {
    return /\/flow|\/radio|\/channels\//.test(location.pathname);
  }

  function send() {
    if (isFlowOrRadio()) {
      log("flow/radio : préchargement désactivé");
      return;
    }
    const probed = probePlayer();
    const current = probed?.tracks[0] ?? probeCurrent();
    const next = probed?.tracks.slice(1, 3) ?? [];
    const payload = {
      current,
      next,
      checkedAt: Date.now() / 1000,
      note: probed?.method ?? "file introuvable — repli URL",
      resolutionMethod: current?.deezerId ? "deezer_id" : "url",
      url: location.href,
    };
    const serialized = JSON.stringify(payload);
    if (serialized === lastPayload) return;
    lastPayload = serialized;
    if (typeof GM_xmlhttpRequest === "function") {
      GM_xmlhttpRequest({
        method: "POST",
        url: ENDPOINT,
        headers: { "Content-Type": "application/json" },
        data: serialized,
      });
    } else {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialized,
      }).catch(() => {});
    }
    log(payload.note, payload.current, payload.next);
  }

  // Sonde les clés susceptibles de contenir le lecteur, sans supposer leur nom.
  const found = Object.keys(window)
    .filter((key) => /player|dz|deezer/i.test(key))
    .slice(0, 40);
  log("clés window candidates :", found);

  setInterval(send, 5000);
  window.addEventListener("popstate", send);
  setTimeout(send, 1500);
})();
