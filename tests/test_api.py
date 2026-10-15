"""API : envoi, analyse, lecture, session."""

from __future__ import annotations

import sys
import time
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from server import main
from server.config import load_settings
from tests.make_fixture import write_synthetic_track


@pytest.fixture()
def client(tmp_path: Path):
    previous_state = main.state
    previous_settings = main.settings
    main.settings = replace(
        previous_settings,
        session_dir=str(tmp_path / "night-light-sessions"),
        cache_dir=str(tmp_path / "night-light-cache"),
    )
    main.state = main.AppState(main.settings)
    with TestClient(main.app) as test_client:
        yield test_client
    main.state.executor.shutdown(wait=False)
    main.state = previous_state
    main.settings = previous_settings


def wait_for_job(client: TestClient, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        last = client.get(f"/api/jobs/{job_id}").json()
        if last["status"] in {"done", "error"}:
            return last
        time.sleep(0.15)
    return last


def test_health(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["limits"]["maxFileBytes"] > 0
    assert body["limits"]["maxDurationSec"] > 0
    assert "mp3" in body["formats"]
    assert body["tools"]["ffmpeg"] is True


def test_cycle_complet(client: TestClient, tmp_path: Path) -> None:
    track = tmp_path / "morceau.wav"
    write_synthetic_track(track, duration=10.0)

    response = client.post(
        "/api/analyze",
        files={"file": ("morceau.wav", track.read_bytes(), "audio/wav")},
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["jobId"]

    job = wait_for_job(client, job_id)
    assert job["status"] == "done", job.get("error")
    analysis = job["result"]["analysis"]
    assert analysis["schema"] == 1
    assert analysis["duration"] > 9.0
    assert analysis["tempo"] > 60
    assert analysis["beatCount"] > 5
    assert len(analysis["energy"]) > 20
    assert len(analysis["sections"]) >= 1

    # Le morceau reste lisible tant que la session vit.
    track_response = client.get(f"/api/track/{job_id}")
    assert track_response.status_code == 200
    assert track_response.headers["content-type"].startswith("audio/")

    # Suppression de la session : plus d'accès au morceau.
    assert client.delete(f"/api/session/{job_id}").status_code == 200
    assert client.get(f"/api/track/{job_id}").status_code == 404
    assert client.get(f"/api/jobs/{job_id}").status_code == 404


def test_job_inconnu(client: TestClient) -> None:
    assert client.get("/api/jobs/inexistant").status_code == 404


def test_format_refuse(client: TestClient) -> None:
    payload = b"PK\x03\x04" + b"\x00" * 200
    response = client.post(
        "/api/analyze",
        files={"file": ("chanson.wav", payload, "audio/wav")},  # extension mensongère
    )
    assert response.status_code == 415
    assert "Format non pris en charge" in response.json()["detail"]


def test_fichier_vide(client: TestClient) -> None:
    response = client.post("/api/analyze", files={"file": ("vide.wav", b"", "audio/wav")})
    assert response.status_code == 400


def test_fichier_trop_volumineux(client: TestClient) -> None:
    previous = main.settings
    main.settings = replace(previous, max_file_bytes=2048)
    main.state.settings = main.settings
    try:
        response = client.post(
            "/api/analyze",
            files={"file": ("gros.wav", b"\x00" * 8192, "audio/wav")},
        )
    finally:
        main.settings = previous
        main.state.settings = previous
    assert response.status_code == 413
    assert "trop volumineux" in response.json()["detail"]


def test_piste_trop_courte(client: TestClient, tmp_path: Path) -> None:
    tiny = tmp_path / "tropcourt.wav"
    sf.write(tiny, [0.0] * 2000, 22050, subtype="PCM_16")
    response = client.post(
        "/api/analyze", files={"file": ("tropcourt.wav", tiny.read_bytes(), "audio/wav")}
    )
    job_id = response.json()["jobId"]
    job = wait_for_job(client, job_id)
    assert job["status"] == "error"
    assert job["error"]["code"] == "too_short"


def test_morceau_trop_long(client: TestClient, tmp_path: Path) -> None:
    previous = main.settings
    main.settings = replace(previous, max_duration_sec=2.0)
    main.state.settings = main.settings
    try:
        track = tmp_path / "long.wav"
        write_synthetic_track(track, duration=8.0)
        response = client.post(
            "/api/analyze", files={"file": ("long.wav", track.read_bytes(), "audio/wav")}
        )
        job_id = response.json()["jobId"]
        job = wait_for_job(client, job_id)
    finally:
        main.settings = previous
        main.state.settings = previous
    assert job["status"] == "error"
    assert job["error"]["code"] == "too_long"


def test_repertoire_session_dangereux_refuse(tmp_path: Path) -> None:
    """Un répertoire de sessions au nom inattendu est refusé : c'est la garde
    qui empêche une purge d'effacer autre chose qu'un espace jetable."""
    from server.store import SessionStore

    with pytest.raises(ValueError):
        SessionStore(tmp_path, 60)


def test_session_dir_vide_retombe_sur_le_defaut(monkeypatch) -> None:

    monkeypatch.setenv("SESSION_DIR", "")
    assert load_settings().session_dir == "/tmp/night-light-sessions"
    monkeypatch.setenv("SESSION_DIR", "   ")
    assert load_settings().session_dir == "/tmp/night-light-sessions"
    # Le répertoire personnel lui-même ne peut pas servir d'espace de sessions.
    monkeypatch.setenv("SESSION_DIR", str(Path.home()))
    assert load_settings().session_dir == "/tmp/night-light-sessions"
    monkeypatch.setenv("SESSION_DIR", "/")
    assert load_settings().session_dir == "/tmp/night-light-sessions"


def test_session_dir_valide_est_conserve(monkeypatch, tmp_path: Path) -> None:

    target = tmp_path / "night-light-sessions"
    monkeypatch.setenv("SESSION_DIR", str(target))
    assert load_settings().session_dir == str(target)


def test_cache_dir_par_defaut_survit_au_redemarrage(monkeypatch) -> None:
    """Le cache persistant ne doit pas vivre sous /tmp : tmpfs vidé au reboot."""
    monkeypatch.delenv("CACHE_DIR", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    cache_dir = Path(load_settings().cache_dir)
    assert cache_dir.is_absolute()
    assert not cache_dir.is_relative_to(Path("/tmp"))
    assert cache_dir == (Path.home() / ".local" / "share" / "night-light" / "cache").resolve()


def test_cache_dir_respecte_xdg_et_override(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("CACHE_DIR", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    assert (
        Path(load_settings().cache_dir) == (tmp_path / "data" / "night-light" / "cache").resolve()
    )

    monkeypatch.setenv("CACHE_DIR", str(tmp_path / "custom-cache"))
    assert Path(load_settings().cache_dir) == tmp_path / "custom-cache"
