"""Mesure la chronologie réelle de résolution + analyse (hors réseau Deezer).

À utiliser quand on veut vérifier l'effet du cache d'analyse sur de vrais
fichiers : le fournisseur est remplacé par une copie locale pour ne pas dépendre
d'un compte Deezer, mais `resolve_track`, le cache audio, l'analyse librosa et le
cache d'analyse sont les vrais chemins du serveur.

    uv run python scripts/bench_chronology.py fichier1.oga fichier2.oga ...
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import main  # noqa: E402
from server.retrieve.match import MatchThresholds  # noqa: E402
from server.retrieve.models import Candidate, TrackQuery  # noqa: E402


class LocalProvider:
    """Fournisseur factice : recherche locale et copie du fichier fourni."""

    name = "local"

    def __init__(self, source: Path) -> None:
        self.source = source
        self.thresholds = MatchThresholds()

    def search(self, query: TrackQuery) -> list[Candidate]:
        return [
            Candidate(
                provider=self.name,
                source_id=query.title,
                title=query.title,
                artist=query.artist,
                duration_sec=query.duration_sec,
            )
        ]

    def download(self, candidate: Candidate, destination: Path) -> Path:
        target = destination / f"audio{self.source.suffix}"
        shutil.copyfile(self.source, target)
        return target


def measure(track: Path, workspace: Path, cache_dir: Path) -> dict[str, object]:
    settings = replace(
        main.load_settings(),
        session_dir=str(workspace / "night-light-sessions"),
        cache_dir=str(cache_dir),
        deezer_arl="bench",
        analysis_cache_max_bytes=256 * 1024 * 1024,
    )
    state = main.AppState(settings)
    provider = LocalProvider(track)
    original_provider = main.DeezerProvider
    main.DeezerProvider = lambda **_: provider  # type: ignore[assignment]
    title, artist = track.stem.replace("_", " "), "Bench"
    duration = 200.0
    try:
        rows = []
        for label in ("premier passage", "cache"):
            job = state.store.create(title, 0)
            started = time.monotonic()
            state.run_resolve(job.id, title, artist, duration, f"{title}|{artist}")
            while True:
                current = state.store.get(job.id)
                if current is None or current.status in {"done", "error"}:
                    break
                time.sleep(0.05)
            wall = (time.monotonic() - started) * 1000
            current = state.store.get(job.id)
            rows.append(
                {
                    "passage": label,
                    "statut": current.status if current else "disparu",
                    "murMs": round(wall),
                    "timings": current.timings if current else None,
                    "analysis": current.result["analysis"] if current and current.result else None,
                }
            )
        return {"track": track.name, "rows": rows}
    finally:
        main.DeezerProvider = original_provider  # type: ignore[assignment]
        state.executor.shutdown(wait=False)


def run_bench() -> None:
    track_paths = [Path(arg).expanduser().resolve() for arg in sys.argv[1:]]
    if len(track_paths) < 1:
        raise SystemExit("usage: uv run python scripts/bench_chronology.py <fichier> [...]")
    results = []
    with tempfile.TemporaryDirectory(prefix="night-light-bench-") as tmp:
        workspace = Path(tmp)
        for index, track in enumerate(track_paths):
            cache_dir = workspace / f"cache-{index}"
            results.append(measure(track, workspace, cache_dir))
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    run_bench()
