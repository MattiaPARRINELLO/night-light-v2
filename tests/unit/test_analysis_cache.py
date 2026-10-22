import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.analysis_cache import AnalysisCache


def _analysis(marker: str = "") -> dict:
    return {"duration": 12.5, "tempo": 120.0, "marker": marker}


def test_put_then_get_roundtrip(tmp_path: Path) -> None:
    cache = AnalysisCache(tmp_path, version="3")
    cache.put("track-key", _analysis("ok"))
    assert cache.get("track-key") == _analysis("ok")


def test_corrupted_json_is_discarded(tmp_path: Path) -> None:
    cache = AnalysisCache(tmp_path, version="3")
    cache.put("track-key", _analysis())
    path = cache.path_for("track-key")
    path.write_text("{ pas du json", encoding="utf-8")
    assert cache.get("track-key") is None
    assert not path.exists()


def test_version_change_invalidates_entry(tmp_path: Path) -> None:
    AnalysisCache(tmp_path, version="3").put("track-key", _analysis())
    assert AnalysisCache(tmp_path, version="4").get("track-key") is None


def test_lru_purge_removes_oldest_entries(tmp_path: Path) -> None:
    cache = AnalysisCache(tmp_path, version="3", max_bytes=250)
    payload = {"duration": 1.0, "pad": "x" * 100}
    cache.put("first", payload)
    time.sleep(0.01)
    cache.put("second", payload)
    # Le total dépasse la limite : l'entrée la plus ancienne est supprimée.
    assert cache.get("first") is None
    assert cache.get("second") == payload


def test_put_is_atomic_and_leaves_no_temp_file(tmp_path: Path) -> None:
    cache = AnalysisCache(tmp_path, version="3")
    cache.put("track-key", _analysis())
    assert not list(tmp_path.glob("analysis-*.tmp"))
    stored = json.loads(cache.path_for("track-key").read_text(encoding="utf-8"))
    assert stored["version"] == "3"
    assert stored["key"] == "track-key"
