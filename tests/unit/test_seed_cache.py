import sys
import time
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest
from fastapi.testclient import TestClient

from server import main
from server.retrieve.cache import AudioCache
from server.retrieve.models import TrackQuery
from server.retrieve.seed import SeedError, build_query, probe_metadata, seed_track
from tests.support.make_fixture import write_synthetic_track


def _cache(tmp_path: Path) -> AudioCache:
    return AudioCache(tmp_path / "cache")


def test_probe_metadata_falls_back_to_filename(tmp_path: Path) -> None:
    audio = tmp_path / "Damso - Vie Olance X Vantablack.wav"
    write_synthetic_track(audio, duration=4.0)

    metadata = probe_metadata(audio)

    assert metadata.title == "Vie Olance X Vantablack"
    assert metadata.artist == "Damso"
    assert metadata.duration_sec == pytest.approx(4.0, abs=0.05)


def test_build_query_accepts_overrides(tmp_path: Path) -> None:
    audio = tmp_path / "morceau.wav"
    write_synthetic_track(audio, duration=4.0)

    query = build_query(audio, title="Σ. MOROSE (LIVE)", artist="Damso")

    assert query.title == "Σ. MOROSE (LIVE)"
    assert query.artist == "Damso"
    assert query.duration_sec == pytest.approx(4.0, abs=0.05)


def test_build_query_uses_explicit_duration_when_unreadable(tmp_path: Path) -> None:
    audio = tmp_path / "tronque.wav"
    audio.write_bytes(b"pas de l'audio")
    query = build_query(audio, title="Tronqué", artist="Test", duration_sec=212.5)
    assert query.duration_sec == 212.5


def test_seeded_track_is_found_with_artist_variants(tmp_path: Path) -> None:
    audio = tmp_path / "Damso - Σ. MOROSE (LIVE).wav"
    write_synthetic_track(audio, duration=4.0)
    cache = _cache(tmp_path)

    entry = seed_track(cache, audio)
    assert entry.path.is_file()

    # Le lecteur peut annoncer un crédit différent et une durée arrondie.
    hit = cache.find_for_query(
        TrackQuery(title="Σ. MOROSE (LIVE)", artist="Damso, Kalash", duration_sec=5.0)
    )
    assert hit is not None
    assert hit.path == entry.path


def test_seeded_track_is_served_without_deezer_account(tmp_path: Path) -> None:
    """Un morceau pré-rempli ne doit pas exiger DEEZER_ARL pour être joué."""
    audio = tmp_path / "Damso - Vie Olance X Vantablack.wav"
    write_synthetic_track(audio, duration=4.0)
    cache_dir = tmp_path / "night-light-cache"
    seed_track(AudioCache(cache_dir), audio)

    previous_state = main.state
    previous_settings = main.settings
    main.settings = replace(
        previous_settings,
        session_dir=str(tmp_path / "night-light-sessions"),
        cache_dir=str(cache_dir),
        deezer_arl="",
    )
    main.state = main.AppState(main.settings)
    try:
        with TestClient(main.app) as client:
            response = client.post(
                "/api/resolve",
                json={
                    "title": "Vie Olance X Vantablack",
                    "artist": "Damso",
                    "duration_sec": 4.0,
                },
            )
            assert response.status_code == 202, response.text
            job_id = response.json()["jobId"]
            deadline = time.monotonic() + 20.0
            job = {}
            while time.monotonic() < deadline:
                job = client.get(f"/api/jobs/{job_id}").json()
                if job["status"] in {"done", "error"}:
                    break
                time.sleep(0.1)
    finally:
        main.state.executor.shutdown(wait=False)
        main.state = previous_state
        main.settings = previous_settings

    assert job["status"] == "done", job


def test_seed_refuses_duplicate_without_replace(tmp_path: Path) -> None:
    audio = tmp_path / "Damso - Morose.wav"
    write_synthetic_track(audio, duration=3.0)
    cache = _cache(tmp_path)

    seed_track(cache, audio)
    with pytest.raises(SeedError, match="déjà dans le cache"):
        seed_track(cache, audio)

    replaced = seed_track(cache, audio, replace=True)
    assert replaced.path.is_file()


def test_seed_dry_run_writes_nothing(tmp_path: Path) -> None:
    audio = tmp_path / "Damso - Morose.wav"
    write_synthetic_track(audio, duration=3.0)
    cache = _cache(tmp_path)

    seed_track(cache, audio, dry_run=True)

    assert list(cache.root.iterdir()) == []
