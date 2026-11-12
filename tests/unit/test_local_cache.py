"""Cache local des dépôts manuels : un fichier déposé doit resservir au resolve."""

from __future__ import annotations

import sys
import time
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest
from fastapi.testclient import TestClient

from server import main
from server.local_cache import LocalUploadCache, probe_metadata
from tests.support.make_fixture import write_synthetic_track


@pytest.fixture()
def client(tmp_path: Path):
    previous_state = main.state
    previous_settings = main.settings
    main.settings = replace(
        previous_settings,
        session_dir=str(tmp_path / "night-light-sessions"),
        cache_dir=str(tmp_path / "night-light-cache"),
        deezer_arl="",
    )
    main.state = main.AppState(main.settings)
    with TestClient(main.app) as test_client:
        yield test_client
    main.state.executor.shutdown(wait=False)
    main.state = previous_state
    main.settings = previous_settings


def _wait_for_job(client: TestClient, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.monotonic() + timeout
    last: dict = {}
    while time.monotonic() < deadline:
        last = client.get(f"/api/jobs/{job_id}").json()
        if last.get("status") in {"done", "error"}:
            return last
        time.sleep(0.1)
    return last


def test_probe_metadata_retombe_sur_le_nom_de_fichier(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    write_synthetic_track(audio, duration=1.0)
    title, artist, duration = probe_metadata(audio, "Artiste - Titre.wav")
    assert title == "Titre"
    assert artist == "Artiste"
    assert duration is None or duration > 0


def test_put_puis_find_par_metadonnees(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    write_synthetic_track(audio, duration=2.0)
    cache = LocalUploadCache(tmp_path / "local")
    analysis = {"schema": 2, "duration": 2.0, "tempo": 120.0}
    cache.put(
        audio,
        analysis,
        key="abc123",
        title="Titre",
        artist="Artiste",
        filename="Artiste - Titre.wav",
        duration_sec=2.0,
    )
    found = cache.find("Titre", "Artiste", 2.1)
    assert found is not None
    assert found.analysis["tempo"] == 120.0
    assert found.audio_path.is_file()
    assert cache.find("Titre", "Autre", 2.0) is None
    assert cache.find("Titre", "Artiste", 10.0) is None


def test_un_depot_manuel_est_resservi_au_resolve(client: TestClient, tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    write_synthetic_track(audio, duration=6.0)
    filename = "Artiste Local - Titre Local.wav"
    upload = client.post(
        "/api/analyze",
        files={"file": (filename, audio.read_bytes(), "audio/wav")},
    )
    assert upload.status_code == 202, upload.text
    uploaded = _wait_for_job(client, upload.json()["jobId"])
    assert uploaded["status"] == "done", uploaded.get("error")
    duration = float(uploaded["result"]["analysis"]["duration"])

    # Nouveau job de résolution, comme si MPRIS jouait le même fichier : le
    # serveur doit retrouver le dépôt local sans Deezer configuré.
    resolved_response = client.post(
        "/api/resolve",
        json={"title": "Titre Local", "artist": "Artiste Local", "duration_sec": duration},
    )
    assert resolved_response.status_code == 202, resolved_response.text
    resolved = _wait_for_job(client, resolved_response.json()["jobId"])
    assert resolved["status"] == "done", resolved.get("error")
    assert resolved["timings"]["localCache"] is True
    assert resolved["timings"]["analysisCache"] is True

    track = client.get(f"/api/track/{resolved['jobId']}")
    assert track.status_code == 200
    assert len(track.content) > 0

    # Redéposer exactement le même fichier ne relance pas l'analyse.
    again = client.post(
        "/api/analyze",
        files={"file": (filename, audio.read_bytes(), "audio/wav")},
    )
    assert again.status_code == 202, again.text
    cached_job = _wait_for_job(client, again.json()["jobId"])
    assert cached_job["status"] == "done"
    assert cached_job["timings"]["localCache"] is True
    assert cached_job["timings"]["analysisMs"] == 0
