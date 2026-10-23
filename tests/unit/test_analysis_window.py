from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.analysis import analyze_file
from server.config import load_settings
from tests.support.make_fixture import write_synthetic_track


def test_window_analysis_publishes_coverage_and_extrapolates_beats(tmp_path: Path) -> None:
    track = tmp_path / "window.wav"
    write_synthetic_track(track, duration=12.0)
    settings = replace(load_settings(), sample_rate=22050, curve_rate_hz=10)

    partial = analyze_file(track, settings, window=(2.0, 8.0))

    assert partial.coverage is not None
    start, end = partial.coverage
    assert abs(start - 2.0) < 0.01
    assert abs(end - 8.0) < 0.01
    assert abs(partial.duration - 12.0) < 0.1
    # La grille est extrapolée hors fenêtre : elle couvre tout le morceau.
    assert partial.beats[0] < 2.0
    assert partial.beats[-1] > 8.0
    assert partial.tempo > 0
    assert len(partial.energy) > 10


def test_full_analysis_has_no_coverage(tmp_path: Path) -> None:
    track = tmp_path / "full.wav"
    write_synthetic_track(track, duration=8.0)
    settings = replace(load_settings(), sample_rate=22050, curve_rate_hz=10)

    full = analyze_file(track, settings)

    assert full.coverage is None
    assert abs(full.duration - 8.0) < 0.1


def test_partial_result_published_before_final_and_only_final_cached(
    tmp_path: Path, monkeypatch
) -> None:
    import threading

    from server import main
    from server.analysis import AnalysisResult

    track = tmp_path / "partial.wav"
    write_synthetic_track(track, duration=8.0)
    settings = replace(
        load_settings(),
        session_dir=str(tmp_path / "night-light-sessions"),
        cache_dir=str(tmp_path / "cache"),
    )
    state = main.AppState(settings)
    job = state.store.create("Partial", 0)
    job.audio_path = track
    release = threading.Event()

    def partial_result(coverage):
        return AnalysisResult(
            duration=8.0,
            tempo=128.0,
            meter=4,
            beats=[0.0, 0.47, 0.94, 7.5],
            onsets=[0.0],
            energy=[[0.0, 0.5], [8.0, 0.5]],
            bass=[[0.0, 0.5], [8.0, 0.5]],
            mid=[[0.0, 0.5], [8.0, 0.5]],
            mid_low=[[0.0, 0.5], [8.0, 0.5]],
            mid_high=[[0.0, 0.5], [8.0, 0.5]],
            high=[[0.0, 0.5], [8.0, 0.5]],
            sections=[{"start": 0, "end": 8.0, "label": "intense", "energy": 0.5}],
            builds=[],
            coverage=coverage,
        )

    calls: list[tuple[float, float] | None] = []

    def fake_quick(path, settings, report=None, window=None, should_cancel=None):
        calls.append(window)
        return partial_result(window)

    def fake_full(
        path, settings, report=None, timeout_sec=None, should_cancel=None, window=None
    ):
        calls.append(window)
        release.wait(timeout=5.0)
        return partial_result(None)

    monkeypatch.setattr("server.main.analyze_file", fake_quick)
    monkeypatch.setattr("server.main.analyze_with_timeout", fake_full)

    thread = threading.Thread(
        target=state.run_analysis,
        args=(job.id,),
        kwargs={"analysis_key": "partial-key", "window": (1.0, 6.0)},
    )
    thread.start()
    try:
        for _ in range(100):
            current = state.store.get(job.id)
            if current is not None and current.result is not None:
                break
            threading.Event().wait(0.02)
        current = state.store.get(job.id)
        assert current is not None
        assert current.result is not None
        assert current.result["partial"] is True
        assert current.result["analysis"]["coverage"] == [1.0, 6.0]
        assert current.status != "done"
        # La passe rapide ne doit jamais entrer dans le cache.
        assert state.analysis_cache.get("partial-key") is None
    finally:
        release.set()
        thread.join(timeout=5.0)

    final = state.store.get(job.id)
    assert final is not None and final.status == "done"
    assert "partial" not in (final.result or {})
    assert state.analysis_cache.get("partial-key") is not None
    assert calls[0] == (1.0, 6.0)
    assert calls[1] is None
    state.executor.shutdown(wait=False)


def test_cancelled_during_quick_pass_publishes_nothing(tmp_path: Path, monkeypatch) -> None:
    from server import main
    from server.analysis import AnalysisError

    track = tmp_path / "cancel.wav"
    write_synthetic_track(track, duration=4.0)
    settings = replace(
        load_settings(),
        session_dir=str(tmp_path / "night-light-sessions"),
        cache_dir=str(tmp_path / "cache"),
    )
    state = main.AppState(settings)
    job = state.store.create("Cancel", 0)
    job.audio_path = track

    def fake_quick(path, settings, report=None, window=None, should_cancel=None):
        raise AnalysisError("cancelled", "Analyse abandonnée.", "")

    monkeypatch.setattr("server.main.analyze_file", fake_quick)
    state.run_analysis(job.id, window=(0.0, 3.0))

    current = state.store.get(job.id)
    assert current is not None
    assert current.status == "error"
    assert current.error is not None and current.error["code"] == "cancelled"
    assert current.result is None or "partial" not in current.result
    state.executor.shutdown(wait=False)
