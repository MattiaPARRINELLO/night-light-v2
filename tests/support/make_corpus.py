"""Génère le corpus de mesure du plan de spectacle.

Le corpus sert aux diagnostics de `plan_diagnostic.ts` et aux mesures de
référence des correctifs du plan. Il contient six pistes analysées par le vrai
serveur :

- 60 s à 60, 90 et 128 BPM, niveau normal ;
- 60 s à 170 BPM ;
- la piste à 128 BPM mais très faible niveau (0,12), pour l'énergie basse ;
- la piste « riche » de `make_fixture.py` (quatre caractères successifs).

Usage :
    uv run python tests/support/make_corpus.py [destination]

Chaque piste produit un WAV (conservé pour réanalyse) et un JSON conforme au
schéma 2 du serveur, consommable directement par le diagnostic TypeScript.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from make_fixture import write_rich_track, write_synthetic_track  # noqa: E402

from server.analysis import AnalysisResult, analyze_file  # noqa: E402
from server.config import load_settings  # noqa: E402

DEFAULT_DESTINATION = Path("/tmp/night-light-plan-corpus")


def to_schema(result: AnalysisResult) -> dict:
    """Même projection que `server.main.to_schema`, sans démarrer l'application."""
    beat_period = round(60.0 / result.tempo, 6) if result.tempo > 0 else 0.5
    return {
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
        "drops": result.drops,
        **({"coverage": list(result.coverage)} if result.coverage is not None else {}),
    }


def tracks() -> list[tuple[str, Path, dict]]:
    """Nom, fichier et paramètres de génération de chaque piste du corpus."""
    return [
        ("60bpm", Path("60bpm.wav"), {"duration": 60.0, "bpm": 60.0, "level": 0.9}),
        ("90bpm", Path("90bpm.wav"), {"duration": 60.0, "bpm": 90.0, "level": 0.9}),
        ("128bpm", Path("128bpm.wav"), {"duration": 60.0, "bpm": 128.0, "level": 0.9}),
        ("170bpm", Path("170bpm.wav"), {"duration": 60.0, "bpm": 170.0, "level": 0.9}),
        ("128bpm-low", Path("128bpm-low.wav"), {"duration": 60.0, "bpm": 128.0, "level": 0.12}),
        ("rich", Path("rich.wav"), {}),
    ]


def main() -> None:
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DESTINATION
    destination.mkdir(parents=True, exist_ok=True)
    settings = load_settings()
    manifest: list[dict] = []

    for name, filename, options in tracks():
        path = destination / filename
        if not path.exists():
            if name == "rich":
                write_rich_track(path, duration=60.0)
            else:
                write_synthetic_track(path, **options)
        result = analyze_file(path, settings)
        schema = to_schema(result)
        json_path = destination / f"{name}.json"
        json_path.write_text(
            json.dumps(schema, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        manifest.append(
            {
                "name": name,
                "json": json_path.name,
                "tempo": schema["tempo"],
                "meter": schema["meter"],
                "duration": schema["duration"],
                "beats": len(schema["beats"]),
                "sections": len(schema["sections"]),
                "builds": len(schema["builds"]),
            }
        )
        print(
            f"{name:11s} {schema['duration']:6.1f} s  {schema['tempo']:7.3f} BPM  "
            f"meter {schema['meter']}  {len(schema['beats']):4d} temps  "
            f"{len(schema['builds'])} montées"
        )

    (destination / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nCorpus écrit dans {destination}")


if __name__ == "__main__":
    main()
