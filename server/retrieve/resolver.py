"""Orchestration séquentielle d'une requête de retrieval vers un fournisseur."""

from __future__ import annotations

import tempfile
import time
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

from .cache import AudioCache, AudioCacheError
from .match import MatchThresholds, validate_match
from .models import Candidate, TrackQuery, audio_cache_key, normalize_text
from .providers import AudioProvider


@dataclass(frozen=True)
class RetrievalTimings:
    search_sec: float
    validation_sec: float
    download_sec: float
    cache_sec: float
    total_sec: float


@dataclass(frozen=True)
class RetrievalResult:
    query: TrackQuery
    candidate: Candidate
    cache_entry_path: Path
    timings: RetrievalTimings
    from_cache: bool


class RetrievalError(Exception):
    """Erreur de retrieval avec code exploitable."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def resolve_track(
    query: TrackQuery,
    provider: AudioProvider,
    cache: AudioCache,
    *,
    thresholds: MatchThresholds | None = None,
    downloads_dir: Path | None = None,
    progress: Callable[[str, float, str], None] | None = None,
    preselected: list[Candidate] | None = None,
) -> RetrievalResult:
    thresholds = thresholds or MatchThresholds()
    key = audio_cache_key(query)
    total_start = time.monotonic()

    def report(phase: str, ratio: float, detail: str) -> None:
        if progress is not None:
            with suppress(Exception):
                progress(phase, max(0.0, min(1.0, ratio)), detail)

    with cache.lock_for(key):
        report("Cache", 0.0, "Vérification du cache persistant")
        hit = cache.get(key, validate_hash=True)
        if hit is not None:
            report("Cache", 1.0, "Morceau déjà disponible")
        if hit is not None:
            return RetrievalResult(
                query=query,
                candidate=Candidate(
                    provider="cache",
                    source_id=key,
                    title=query.title,
                    artist=query.artist,
                    duration_sec=query.duration_sec,
                    local_path=hit.path,
                ),
                cache_entry_path=hit.path,
                timings=RetrievalTimings(0.0, 0.0, 0.0, 0.0, time.monotonic() - total_start),
                from_cache=True,
            )

        report("Recherche", 0.0, "Recherche des candidats")
        if preselected is not None:
            candidates = list(preselected)
            search_elapsed = 0.0
        else:
            search_start = time.monotonic()
            try:
                candidates = provider.search(query)
            except Exception as error:  # noqa: BLE001
                raise RetrievalError("search_failed", str(error)) from error
            search_elapsed = time.monotonic() - search_start
        report("Recherche", 1.0, f"{len(candidates)} candidats trouvés")

        report("Validation", 0.0, "Validation des correspondances")
        validation_start = time.monotonic()
        accepted: list[tuple[float, Candidate]] = []
        for candidate in candidates:
            result = validate_match(query, candidate, thresholds)
            if result.accepted:
                accepted.append((result.score, candidate))
        if not accepted:
            raise RetrievalError(
                "no_match", "aucun candidat ne correspond aux métadonnées demandées"
            )
        accepted.sort(key=lambda item: item[0], reverse=True)
        validation_elapsed = time.monotonic() - validation_start
        report("Validation", 1.0, f"{len(accepted)} correspondance(s) retenue(s)")

        # Déduplication par titre/artiste pour évaluer l'ambiguïté réelle.
        unique: list[tuple[float, Candidate]] = []
        seen_keys: set[str] = set()
        for score, cand in accepted:
            canonical = " ".join(
                token
                for token in normalize_text(cand.title).split()
                if token
                not in {
                    "official",
                    "audio",
                    "video",
                    "clip",
                    "officiel",
                    "originale",
                    "provided",
                    "youtube",
                    "topic",
                    "original",
                }
            )
            key = normalize_text(f"{canonical}|{cand.artist}")
            if key in seen_keys:
                continue
            seen_keys.add(key)
            unique.append((score, cand))
        if len(unique) >= 2:
            candidate_core = " ".join(
                token
                for token in unique[0][1].normalized_title.split()
                if token
                not in {
                    "official",
                    "audio",
                    "video",
                    "clip",
                    "officiel",
                    "originale",
                    "provided",
                    "youtube",
                    "topic",
                    "original",
                }
            )
            query_core = " ".join(
                token
                for token in query.normalized_title.split()
                if token
                not in {
                    "official",
                    "audio",
                    "video",
                    "clip",
                    "officiel",
                    "originale",
                    "provided",
                    "youtube",
                    "topic",
                    "original",
                }
            )
            top_exact_title = candidate_core == query_core
            if (not top_exact_title or unique[0][0] < thresholds.min_score) and (
                unique[0][0] >= thresholds.min_score and (unique[0][0] - unique[1][0]) < 2.0
            ):
                raise RetrievalError(
                    "ambiguous_match",
                    "Plusieurs correspondances trop proches : précise le titre, "
                    "l'artiste ou la durée.",
                )

        download_root = (downloads_dir or (cache.root.parent / "retrieval-downloads")).resolve()
        download_root.mkdir(parents=True, exist_ok=True)
        errors: list[str] = []
        with tempfile.TemporaryDirectory(prefix="resolve-", dir=str(download_root)) as temp_dir:
            temp_path = Path(temp_dir)
            for _, candidate in accepted:
                report("Téléchargement", 0.0, f"Téléchargement: {candidate.title}")
                download_start = time.monotonic()
                try:
                    downloaded = provider.download(candidate, temp_path)
                except Exception as error:  # noqa: BLE001
                    errors.append(str(error))
                    continue
                download_elapsed = time.monotonic() - download_start
                report("Téléchargement", 1.0, "Téléchargement terminé")
                report("Cache", 0.0, "Écriture du cache")
                cache_start = time.monotonic()
                try:
                    entry = cache.put_for_query(
                        query,
                        downloaded,
                        candidate_provider=getattr(provider, "name", candidate.provider),
                        metadata={
                            "source_id": candidate.source_id,
                            "container": candidate.container,
                            "codec": candidate.codec,
                            "duration_sec": candidate.duration_sec,
                        },
                    )
                except AudioCacheError as error:
                    errors.append(str(error))
                    continue
                cache_elapsed = time.monotonic() - cache_start
                report("Cache", 1.0, "Cache mis à jour")
                return RetrievalResult(
                    query=query,
                    candidate=candidate,
                    cache_entry_path=entry.path,
                    timings=RetrievalTimings(
                        search_sec=search_elapsed,
                        validation_sec=validation_elapsed,
                        download_sec=download_elapsed,
                        cache_sec=cache_elapsed,
                        total_sec=time.monotonic() - total_start,
                    ),
                    from_cache=False,
                )

        detail = errors[-1] if errors else "échec inconnu"
        raise RetrievalError("download_failed", detail)
