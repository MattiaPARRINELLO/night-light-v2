"""Sérialisation de la compilation numba et purge d'un cache corrompu."""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server import analysis


def test_le_verrou_serialise_les_compilations() -> None:
    """Deux compilations simultanées ne doivent jamais se chevaucher."""
    journal: list[tuple[str, str]] = []
    journal_lock = threading.Lock()

    def hold(name: str) -> None:
        with analysis._numba_compile_lock():
            with journal_lock:
                journal.append((name, "entrée"))
            time.sleep(0.2)
            with journal_lock:
                journal.append((name, "sortie"))

    first = threading.Thread(target=hold, args=("premier",))
    second = threading.Thread(target=hold, args=("second",))
    first.start()
    time.sleep(0.05)
    second.start()
    first.join(timeout=5.0)
    second.join(timeout=5.0)

    assert journal == [
        ("premier", "entrée"),
        ("premier", "sortie"),
        ("second", "entrée"),
        ("second", "sortie"),
    ]


def test_la_purge_ne_touche_que_le_cache_numba(tmp_path: Path) -> None:
    (tmp_path / "beat.cpython-312.pyc").write_bytes(b"python")
    (tmp_path / "beat.__last_beat-704.py312.nbi").write_bytes(b"index")
    (tmp_path / "beat.__last_beat-704.py312.1.nbc").write_bytes(b"code")
    nested = tmp_path / "core" / "__pycache__"
    nested.mkdir(parents=True)
    (nested / "pitch._pi_wrapper-435.py312.nbi").write_bytes(b"index")

    analysis._purge_numba_cache(tmp_path)

    assert not list(tmp_path.rglob("*.nbi"))
    assert not list(tmp_path.rglob("*.nbc"))
    assert (tmp_path / "beat.cpython-312.pyc").is_file()


class _FakeProcess:
    """Process dont le préchauffage meurt par signal (comme un segfault numba)."""

    def __init__(self) -> None:
        self.exitcode: int | None = None
        self.démarré = 0

    def start(self) -> None:
        self.démarré += 1

    def is_alive(self) -> bool:
        return False

    def terminate(self) -> None:
        pass

    def join(self, timeout: float | None = None) -> None:
        pass

    def kill(self) -> None:
        pass


class _FakeContext:
    def __init__(self) -> None:
        self.processus: list[_FakeProcess] = []

    def Queue(self) -> object:  # noqa: N802 - imite l'API multiprocessing
        return object()

    def Process(self, **_: object) -> _FakeProcess:  # noqa: N802
        process = _FakeProcess()
        self.processus.append(process)
        return process


def test_un_worker_tue_au_prechauffage_purge_et_relance(monkeypatch) -> None:
    moteur = analysis.PersistentAnalysis()
    contexte = _FakeContext()
    moteur._context = contexte  # type: ignore[assignment]
    appels = {"purges": 0, "prechauffages": 0}

    def purge(root: Path | None = None) -> None:
        appels["purges"] += 1

    def await_ready() -> None:
        appels["prechauffages"] += 1
        process = moteur._process
        if appels["prechauffages"] == 1:
            process.exitcode = -11
            raise analysis._EngineUnavailable("tué au préchauffage")

    monkeypatch.setattr(analysis, "_purge_numba_cache", purge)
    monkeypatch.setattr(moteur, "_await_ready", await_ready)

    moteur._spawn()

    assert appels["purges"] == 1
    assert appels["prechauffages"] == 2
    assert len(contexte.processus) == 2
