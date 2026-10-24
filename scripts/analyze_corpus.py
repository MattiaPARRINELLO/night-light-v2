"""Analyse tout le corpus de test et écrit les analyses au format du front.

Utilisé par `scripts/measure.ts` : l'analyse est faite une seule fois par piste,
puis le plan et le rendu sont mesurés en TypeScript avec les mêmes fonctions que
la production (`buildShowPlan`, `renderFrame`, `sceneHue`, ...).

    uv run python scripts/analyze_corpus.py \
        --corpus tests/fixtures/corpus --out /tmp/analyses.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.analysis import AnalysisResult, analyze_file  # noqa: E402
from server.config import load_settings  # noqa: E402


def to_schema(result: AnalysisResult) -> dict[str, Any]:
    """Même conversion que `server.main.to_schema` (le contrat du front)."""
    beat_period = round(60.0 / result.tempo, 6) if result.tempo > 0 else 0.5
    payload: dict[str, Any] = {
        "schema": 2,
        "duration": result.duration,
        "tempo": result.tempo,
        "meter": result.meter,
        "beatCount": len(result.beats),
        "beatPeriod": beat_period,
        "beats": result.beats,
        "onsets": result.onsets,
        "energy": result.energy,
        "bass": result.bass,
        "mid": result.mid,
        "midLow": result.mid_low,
        "midHigh": result.mid_high,
        "high": result.high,
        "sections": result.sections,
        "builds": result.builds,
    }
    if result.coverage is not None:
        payload["coverage"] = list(result.coverage)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", default="tests/fixtures/corpus")
    parser.add_argument("--track", action="append", default=[], help="piste isolée (répétable)")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    tracks = [Path(track) for track in args.track] or sorted(Path(args.corpus).glob("*.wav"))
    if not tracks:
        parser.error(f"aucune piste dans {args.corpus} : lance make_fixture.py corpus")

    settings = load_settings()
    payload = []
    for track in tracks:
        result = analyze_file(track, settings)
        payload.append({"name": track.stem, "analysis": to_schema(result)})
        print(f"analysé : {track.stem} ({result.duration:.1f} s)", file=sys.stderr)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"{out} — {len(payload)} analyses", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
