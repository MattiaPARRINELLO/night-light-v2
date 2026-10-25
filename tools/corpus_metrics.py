"""Mesures du corpus réel avant/après : impacts et métrique, morceau par morceau.

Outil HORS production, hors CI : il suppose les analyses réelles déjà générées
dans ``tests/fixtures/analyses`` (voir ``tools/real_corpus.py``). Il ne modifie
rien et ne télécharge rien.

Usage :
    uv run python tools/corpus_metrics.py                  # après courant
    uv run python tools/corpus_metrics.py --before DIR     # compare à DIR
    uv run python tools/corpus_metrics.py --before DIR --json out.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

from build_diagnostic import candidates  # noqa: E402

MANIFEST = ROOT / "tests/support/real_corpus.json"
ANALYSIS_DIR = ROOT / "tests/fixtures/analyses"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def distribution(builds: list[dict]) -> dict:
    strengths = sorted(float(build["strength"]) for build in builds)
    if not strengths:
        return {"count": 0, "min": None, "median": None, "p90": None}
    p90 = strengths[min(len(strengths) - 1, int(round(0.9 * (len(strengths) - 1))))]
    return {
        "count": len(strengths),
        "min": round(strengths[0], 3),
        "median": round(statistics.median(strengths), 3),
        "p90": round(p90, 3),
    }


def rejection_reason(schema: dict, build: dict) -> str:
    """Explique pourquoi un impact d'avant n'est plus retenu, avec ses mesures."""
    items = candidates(
        schema["energy"], schema.get("bass"), float(schema["duration"]), schema.get("onsets")
    )
    match = min(items, key=lambda item: abs(item.start - float(build["start"])), default=None)
    if match is None:
        return "plus de candidat"
    reason = match.criterion if not match.retained else "critère de recevabilité"
    extra = (
        f"gain relatif {match.after_energy - match.base_energy:+.2f} "
        f"(ratio {match.after_energy / max(match.base_energy, 0.05):.2f}), "
        f"basses {match.before_bass:.2f}→{match.after_bass:.2f}"
    )
    return f"{reason} ; {extra}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, default=None)
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args()

    entries = json.loads(MANIFEST.read_text(encoding="utf-8"))
    rows: list[dict] = []
    before_builds: list[dict] = []
    after_builds: list[dict] = []
    suppressed: list[dict] = []

    for entry in entries:
        track_id = int(entry["id"])
        title = str(entry["titre"])
        current = load(ANALYSIS_DIR / f"real-{track_id}.json")
        previous = load(args.before / f"real-{track_id}.json") if args.before is not None else None
        before_builds.extend(previous["builds"] if previous else [])
        after_builds.extend(current["builds"])
        minutes = float(current["duration"]) / 60.0
        row = {
            "titre": title,
            "profil": str(entry["profil"]),
            "drops_avant": len(previous["builds"]) if previous else None,
            "drops_apres": len(current["builds"]),
            "impacts_par_minute": round(len(current["builds"]) / minutes, 2),
            "meter_attendu": int(entry["meter_attendu"]),
            "meter_avant": previous.get("meter") if previous else None,
            "meter_apres": current.get("meter"),
            "horodatages": [build["end"] for build in current["builds"]],
        }
        rows.append(row)

        if previous is not None:
            for build in previous["builds"]:
                kept = any(
                    abs(float(build["end"]) - float(after["end"])) <= 1.0
                    for after in current["builds"]
                )
                if not kept:
                    suppressed.append(
                        {
                            "titre": title,
                            "start": build["start"],
                            "end": build["end"],
                            "strength": build["strength"],
                            "raison": rejection_reason(previous, build),
                        }
                    )

    header = (
        "morceau | profil | drops avant | drops après | impacts/min | "
        "meter attendu | meter avant | meter après | horodatages conservés"
    )
    print(f"### {header}")
    print("| " + " | ".join(header.split(" | ")) + " |")
    print("|" + "---|" * 9)
    for row in rows:
        stamps = ", ".join(f"{value:.1f}" for value in row["horodatages"]) or "—"
        print(
            f"| {row['titre']} | {row['profil']} | {row['drops_avant']} | "
            f"{row['drops_apres']} | {row['impacts_par_minute']:.2f} | "
            f"{row['meter_attendu']} | {row['meter_avant']} | {row['meter_apres']} | {stamps} |"
        )

    print("\n### Distribution de strength")
    print(f"- avant : {distribution(before_builds)}")
    print(f"- après : {distribution(after_builds)}")

    print("\n### Impacts supprimés")
    for item in suppressed:
        print(f"- {item['titre']} @ {item['start']:.2f}–{item['end']:.2f} : {item['raison']}")

    meters_after = sum(1 for row in rows if row["meter_apres"] == row["meter_attendu"])
    print(f"\nMétrique correcte après : {meters_after}/{len(rows)}")
    if args.before is not None:
        meters_before = sum(1 for row in rows if row["meter_avant"] == row["meter_attendu"])
        print(f"Métrique correcte avant : {meters_before}/{len(rows)}")

    if args.json:
        args.json.write_text(
            json.dumps(
                {
                    "rows": rows,
                    "strength": {
                        "avant": distribution(before_builds),
                        "apres": distribution(after_builds),
                    },
                    "supprimes": suppressed,
                    "meter": {
                        "attendu_total": len(rows),
                        "correct_apres": meters_after,
                    },
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"\nJSON : {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
