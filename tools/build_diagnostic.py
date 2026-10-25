"""Journal de diagnostic des impacts (builds) sur le corpus réel et synthétique.

Outil HORS production : il rejoue la détection de montées du serveur en
exposant, pour chaque candidat, les mesures qui décident de sa conservation
(durée, gain, pente, contraste avant/après en énergie et en basses, force) et
le critère qui l'a retenu ou rejeté.

Usage :
    uv run python tools/build_diagnostic.py            # corpus réel analysé
    uv run python tools/build_diagnostic.py --synthetic # corpus de make_corpus
    uv run python tools/build_diagnostic.py --json out.json
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

from server.analysis import (  # noqa: E402
    BUILD_BASS_ONLY_GAIN,
    BUILD_BASS_ONLY_RATIO,
    BUILD_MAX_SPAN,
    BUILD_MIN_AFTER,
    BUILD_MIN_BASS_GAIN,
    BUILD_MIN_LIFT,
    BUILD_MIN_RATIO,
    BUILD_MIN_RISE,
    BUILD_MIN_SPAN,
    BUILD_MIN_STRENGTH,
    BUILD_STRONG_LIFT,
    BUILD_STRONG_RATIO,
    _impact_after_gap,
    _smooth,
    _snap_to_onset,
    sanitize_curve,
)

REAL_MANIFEST = ROOT / "tests/support/real_corpus.json"
ANALYSIS_DIR = ROOT / "tests/fixtures/analyses"
CORPUS_DIR = Path("/tmp/night-light-plan-corpus")


@dataclass
class Candidate:
    start: float
    end: float
    duration: float
    strength: float
    start_level: float
    gain: float
    slope: float
    before_energy: float
    after_energy: float
    before_bass: float
    after_bass: float
    after_sustain: float
    jump: float
    pre_max: float
    gain_vs_pre_max: float
    bass_gain: float
    onset_near: int
    base_energy: float
    base_bass: float
    sm_strength: float
    sm_start: float
    sm_lift: float
    sm_ratio: float
    retained: bool
    criterion: str
    source: str = "rise"

    def as_dict(self) -> dict:
        return {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "duration": round(self.duration, 3),
            "strength": round(self.strength, 3),
            "start_level": round(self.start_level, 3),
            "gain": round(self.gain, 3),
            "slope": round(self.slope, 4),
            "before_energy": round(self.before_energy, 3),
            "after_energy": round(self.after_energy, 3),
            "before_bass": round(self.before_bass, 3),
            "after_bass": round(self.after_bass, 3),
            "after_sustain": round(self.after_sustain, 3),
            "jump": round(self.jump, 3),
            "pre_max": round(self.pre_max, 3),
            "gain_vs_pre_max": round(self.gain_vs_pre_max, 3),
            "bass_gain": round(self.bass_gain, 3),
            "onset_near": self.onset_near,
            "base_energy": round(self.base_energy, 3),
            "base_bass": round(self.base_bass, 3),
            "sm_strength": round(self.sm_strength, 3),
            "sm_start": round(self.sm_start, 3),
            "sm_lift": round(self.sm_lift, 3),
            "sm_ratio": round(self.sm_ratio, 3),
            "retained": self.retained,
            "criterion": self.criterion,
            "source": self.source,
        }


def _window_mean(times: np.ndarray, values: np.ndarray, start: float, end: float) -> float:
    window = (times >= start) & (times < end)
    if not window.any():
        return float(np.interp(start, times, values))
    return float(np.mean(values[window]))


def candidates(
    energy_points: list[list[float]],
    bass_points: list[list[float]] | None,
    duration: float,
    onsets: list[float] | None = None,
) -> list[Candidate]:
    """Rejoue detect_builds et journalise chaque candidat."""
    if len(energy_points) < 8:
        return []
    times = np.array([point[0] for point in energy_points], dtype=float)
    values = sanitize_curve(np.array([point[1] for point in energy_points], dtype=float))
    if bass_points:
        bass_times = np.array([point[0] for point in bass_points], dtype=float)
        bass_values = sanitize_curve(np.array([point[1] for point in bass_points], dtype=float))
    else:
        bass_times = times
        bass_values = np.zeros_like(values)
    rate = 1.0 / max(float(np.median(np.diff(times))) if times.size > 1 else 0.05, 1e-3)
    smooth = _smooth(values, min(2.0, max(0.5, duration / 6.0)), rate)
    gradient = np.gradient(smooth) * rate
    window = max(1, int(min(4.0, max(1.0, duration / 4.0)) * rate))
    derivative = np.convolve(gradient, np.ones(window) / window, mode="same")
    rising = derivative > 0.01

    out: list[Candidate] = []
    index = 0
    while index < len(rising):
        if not rising[index]:
            index += 1
            continue
        start_index = index
        end_index = index
        while end_index < len(rising) and rising[end_index]:
            end_index += 1
        start = float(times[start_index])
        end = float(times[min(end_index, len(times) - 1)])
        peak_slice = values[start_index : min(start_index + int(6 * rate), len(values))]
        strength = float(np.max(peak_slice)) if peak_slice.size > 0 else 0.0
        start_level = float(values[start_index])
        pic = slice(start_index, min(end_index + 1, len(gradient)))
        gap = False
        if pic.stop > pic.start:
            after_gap = _impact_after_gap(
                times,
                values,
                start_index,
                pic.stop,
                onsets,
                float(np.max(values[start_index : pic.stop])),
            )
            if after_gap is not None:
                end = after_gap
                gap = True
            else:
                crest_index = min(int(np.argmax(gradient[pic])) + pic.start, len(times) - 1)
                end = float(times[crest_index])
                end = _snap_to_onset(end, onsets)
        strength = float(np.nan_to_num(strength, nan=0.0, posinf=1.0, neginf=0.0))
        duration_build = end - start
        gain = strength - start_level
        slope = gain / max(duration_build, 1e-3)
        before_energy = _window_mean(times, values, max(0.0, start - 4.0), start)
        after_energy = _window_mean(times, values, end, min(duration, end + 4.0))
        before_bass = _window_mean(bass_times, bass_values, max(0.0, start - 4.0), start)
        after_bass = _window_mean(bass_times, bass_values, end, min(duration, end + 4.0))
        after_sustain = _window_mean(times, values, end, min(duration, end + 8.0))
        jump = _window_mean(times, values, end, min(duration, end + 0.75)) - _window_mean(
            times, values, max(0.0, end - 0.75), end
        )
        pre_window = (times >= max(0.0, start - 12.0)) & (times < start)
        pre_max = float(np.max(values[pre_window])) if pre_window.any() else 0.0
        bass_gain = after_bass - before_bass
        onset_near = (
            sum(1 for onset in (onsets or []) if end - 0.25 <= float(onset) <= end + 0.25)
            if onsets
            else 0
        )
        base_energy = _window_mean(times, values, max(0.0, start - 24.0), max(0.0, start - 4.0))
        base_bass = _window_mean(
            bass_times, bass_values, max(0.0, start - 24.0), max(0.0, start - 4.0)
        )
        base_sm = _window_mean(times, smooth, max(0.0, start - 24.0), max(0.0, start - 4.0))
        after_sm = _window_mean(times, smooth, end, min(duration, end + 8.0))
        sm_strength = float(
            np.max(smooth[start_index : min(start_index + int(max(6 * rate, 1)), smooth.size)])
        )
        sm_start = float(smooth[start_index])
        sm_lift = after_sm - base_sm
        sm_ratio = after_sm / max(base_sm, 0.05)
        criterion = "ok"
        if not (BUILD_MIN_SPAN <= duration_build <= BUILD_MAX_SPAN):
            criterion = (
                f"duree {duration_build:.2f}s hors [{BUILD_MIN_SPAN:.0f},{BUILD_MAX_SPAN:.0f}]"
            )
        elif not strength > BUILD_MIN_STRENGTH:
            criterion = f"force {strength:.2f} <= {BUILD_MIN_STRENGTH:.2f}"
        elif after_sm - sm_start < BUILD_MIN_RISE:
            criterion = (
                f"energie gagnee {after_sm - sm_start:+.2f} < {BUILD_MIN_RISE:.2f} "
                "(plateau vs debut de montee)"
            )
        elif sm_ratio < BUILD_MIN_RATIO:
            criterion = f"ratio {sm_ratio:.2f} < {BUILD_MIN_RATIO:.2f} (dynamique du morceau)"
        elif sm_lift < BUILD_MIN_LIFT:
            criterion = f"gain relatif {sm_lift:+.2f} < {BUILD_MIN_LIFT:.2f}"
        elif after_sm < BUILD_MIN_AFTER:
            criterion = f"plateau {after_sm:.2f} < {BUILD_MIN_AFTER:.2f}"
        elif (
            bass_gain < BUILD_MIN_BASS_GAIN
            and not (
                bass_gain >= BUILD_BASS_ONLY_GAIN
                and after_bass >= BUILD_BASS_ONLY_RATIO * max(before_bass, 0.02)
            )
            and not (sm_ratio >= BUILD_STRONG_RATIO and sm_lift >= BUILD_STRONG_LIFT)
        ):
            criterion = (
                f"pas d'arrivee de basses ({before_bass:.2f}->{after_bass:.2f}, {bass_gain:+.2f})"
            )
        out.append(
            Candidate(
                start=start,
                end=end,
                duration=duration_build,
                strength=strength,
                start_level=start_level,
                gain=gain,
                slope=slope,
                before_energy=before_energy,
                after_energy=after_energy,
                before_bass=before_bass,
                after_bass=after_bass,
                after_sustain=after_sustain,
                jump=jump,
                pre_max=pre_max,
                gain_vs_pre_max=after_energy - pre_max,
                bass_gain=bass_gain,
                onset_near=onset_near,
                base_energy=base_energy,
                base_bass=base_bass,
                sm_strength=sm_strength,
                sm_start=sm_start,
                sm_lift=sm_lift,
                sm_ratio=sm_ratio,
                retained=criterion == "ok",
                criterion=criterion + (" (gap)" if gap and criterion == "ok" else ""),
            )
        )
        index = end_index + 1
    return out


def _merge_retained(items: list[Candidate]) -> list[Candidate]:
    merged: list[Candidate] = []
    for item in items:
        if merged and item.start - merged[-1].end < 1.0:
            last = merged[-1]
            last.end = max(last.end, item.end)
            last.strength = max(last.strength, item.strength)
            last.duration = last.end - last.start
            last.retained = True
            last.criterion = "fusion <1s"
        else:
            merged.append(item)
    return merged


def analyse(path: Path, title: str, profile: str) -> dict:
    schema = json.loads(path.read_text(encoding="utf-8"))
    items = candidates(
        schema["energy"],
        schema.get("bass"),
        float(schema["duration"]),
        schema.get("onsets"),
    )
    retained = _merge_retained([item for item in items if item.retained])
    return {
        "titre": title,
        "profil": profile,
        "duration": schema["duration"],
        "tempo": schema["tempo"],
        "meter": schema.get("meter"),
        "candidates": [item.as_dict() for item in items],
        "retained": [item.as_dict() for item in retained],
        "count": len(retained),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--synthetic", action="store_true")
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args()

    reports: list[dict] = []
    if args.synthetic:
        manifest = json.loads((CORPUS_DIR / "manifest.json").read_text(encoding="utf-8"))
        for entry in manifest:
            path = CORPUS_DIR / str(entry["json"])
            if not path.is_file():
                print(f"absent : {path}", file=sys.stderr)
                continue
            reports.append(analyse(path, str(entry["name"]), "synthétique"))
    else:
        entries = json.loads(REAL_MANIFEST.read_text(encoding="utf-8"))
        for entry in entries:
            path = ANALYSIS_DIR / f"real-{entry['id']}.json"
            if not path.is_file():
                print(f"absent : {path}", file=sys.stderr)
                continue
            reports.append(analyse(path, str(entry["titre"]), str(entry["profil"])))

    for report in reports:
        minutes = report["duration"] / 60.0
        print(
            f"\n{report['titre']} — {report['profil']} — "
            f"{report['count']} retenus / {len(report['candidates'])} candidats "
            f"({report['count'] / minutes:.2f}/min)"
        )
        for item in report["candidates"]:
            flag = "RETENU" if item["retained"] else "rejeté"
            print(
                f"  {item['start']:7.2f} → {item['end']:7.2f} ({item['duration']:5.2f}s) "
                f"force {item['strength']:.2f} gain {item['gain']:+.2f} "
                f"pente {item['slope']:.3f}/s "
                f"E {item['before_energy']:.2f}→{item['after_energy']:.2f} "
                f"B {item['before_bass']:.2f}→{item['after_bass']:.2f} "
                f"tenue {item['after_sustain']:.2f} saut {item['jump']:+.2f} "
                f"avant-max {item['pre_max']:.2f} Δmax {item['gain_vs_pre_max']:+.2f} "
                f"Δbass {item['bass_gain']:+.2f} onsets {item['onset_near']} "
                f"| {flag} | {item['criterion']}"
            )

    if args.json:
        args.json.write_text(
            json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"\njournal écrit dans {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
