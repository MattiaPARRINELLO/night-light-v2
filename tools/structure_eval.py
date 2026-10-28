"""Évalue la détection de sections sur le corpus réel annoté (vague 3 — Structure).

Le script rejoue `analyze_file` sur les morceaux du manifeste réel (audio en
cache Deezer), valide le contrat V3.1 sur chaque sortie, puis compare les
débuts de refrain et les silences à `tests/fixtures/structure_truth.json`.

Usage :
    uv run python tools/structure_eval.py [--json]

Aucun audio n'est versionné : sans cache local, le script s'arrête proprement.
Le cookie Deezer n'est jamais lu ni affiché ici.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.analysis import AnalysisResult, analyze_file  # noqa: E402
from server.config import load_settings  # noqa: E402
from server.retrieve import AudioCache, TrackQuery  # noqa: E402

MANIFEST = ROOT / "tests/support/real_corpus.json"
TRUTH = ROOT / "tests/fixtures/structure_truth.json"
KINDS = {"intro", "couplet", "refrain", "pont", "silence", "outro"}


def contract_violations(result: AnalysisResult) -> list[str]:
    """Toutes les violations du contrat V3.1, liste vide si conforme."""
    problems: list[str] = []
    sections = result.sections
    if not sections:
        return ["aucune section"]
    if abs(float(sections[0]["start"])) > 1e-6:
        problems.append(f"première section à {sections[0]['start']}, pas 0")
    if abs(float(sections[-1]["end"]) - result.duration) > 1e-3:
        problems.append(f"dernière fin {sections[-1]['end']} ≠ durée {result.duration}")
    for index, section in enumerate(sections):
        start = float(section["start"])
        end = float(section["end"])
        if end <= start:
            problems.append(f"section {index} vide ou inversée")
        minimum = 1.5 if section.get("kind") == "silence" else 4.0 - 1e-3
        if end - start < minimum:
            problems.append(f"section {index} trop courte ({end - start:.2f} s)")
        if section.get("kind") not in KINDS:
            problems.append(f"section {index} kind invalide: {section.get('kind')!r}")
        if not isinstance(section.get("group"), str):
            problems.append(f"section {index} group non textuel")
        confidence = section.get("confidence")
        if confidence is None or not 0.0 <= float(confidence) <= 1.0:
            problems.append(f"section {index} confidence invalide")
        if index > 0:
            previous_end = float(sections[index - 1]["end"])
            if abs(previous_end - start) > 1e-6:
                problems.append(f"trou/chevauchement entre {index - 1} et {index}")
    kinds = [section.get("kind") for section in sections]
    if kinds.count("intro") > 1 or (kinds.count("intro") == 1 and kinds[0] != "intro"):
        problems.append("intro mal placée ou multiple")
    if kinds.count("outro") > 1 or (kinds.count("outro") == 1 and kinds[-1] != "outro"):
        problems.append("outro mal placée ou multiple")
    return problems


def refrain_run_starts(sections: list[dict]) -> list[float]:
    """Début de chaque bloc contigu de sections « refrain »."""
    starts: list[float] = []
    previous = None
    for section in sections:
        if section.get("kind") == "refrain" and previous != "refrain":
            starts.append(round(float(section["start"]), 3))
        previous = section.get("kind")
    return starts


def match(detected: list[float], expected: list[float], tolerance: float) -> tuple[int, int, int]:
    """Retourne (vrais positifs, détections, attendus) en appariant au plus proche."""
    remaining = list(expected)
    hits = 0
    for value in detected:
        if not remaining:
            break
        nearest = min(remaining, key=lambda candidate: abs(candidate - value))
        if abs(nearest - value) <= tolerance:
            hits += 1
            remaining.remove(nearest)
    return hits, len(detected), len(expected)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="sortie JSON brute")
    args = parser.parse_args()

    settings = load_settings()
    cache = AudioCache(settings.cache_dir)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    truth = json.loads(TRUTH.read_text(encoding="utf-8"))
    by_id = {int(entry["id"]): entry for entry in truth["tracks"]}
    tolerance = float(truth["toleranceSec"])

    rows: list[dict] = []
    total_hits = total_detected = total_expected = 0
    silence_ok = silence_total = 0
    no_silence_ok = no_silence_total = 0

    for entry in manifest:
        track_id = int(entry["id"])
        expected = by_id.get(track_id)
        if expected is None:
            continue
        query = TrackQuery(title=entry["titre"], artist=entry["artiste"], duration_sec=0.0)
        cached = cache.get_entry_for_query(query)
        if cached is None:
            print(f"absent du cache : {entry['titre']}", file=sys.stderr)
            continue
        started = time.monotonic()
        result = analyze_file(cached.path, settings)
        elapsed = time.monotonic() - started
        problems = contract_violations(result)
        detected = refrain_run_starts(result.sections)
        hits, detected_count, expected_count = match(detected, expected["refrainStarts"], tolerance)
        total_hits += hits
        total_detected += detected_count
        total_expected += expected_count
        detected_silences = [
            round(float(section["start"]), 3)
            for section in result.sections
            if section.get("kind") == "silence"
        ]
        if expected["silences"]:
            silence_total += len(expected["silences"])
            silence_ok += len(
                [
                    value
                    for value in detected_silences
                    if any(abs(value - target) <= tolerance for target in expected["silences"])
                ]
            )
        else:
            no_silence_total += 1
            if not detected_silences:
                no_silence_ok += 1
        rows.append(
            {
                "id": track_id,
                "titre": entry["titre"],
                "meter": result.meter,
                "sections": len(result.sections),
                "kinds": {
                    kind: sum(1 for section in result.sections if section.get("kind") == kind)
                    for kind in sorted(KINDS)
                },
                "attendus": expected["refrainStarts"],
                "detectes": detected,
                "ecart": [
                    round(
                        min(
                            (abs(value - target) for target in expected["refrainStarts"]),
                            default=-1,
                        ),
                        2,
                    )
                    for value in detected
                ],
                "silencesDetectes": detected_silences,
                "violations": problems,
                "analysisSec": round(elapsed, 3),
            }
        )

    precision = total_hits / total_detected if total_detected else 0.0
    recall = total_hits / total_expected if total_expected else 0.0
    payload = {
        "toleranceSec": tolerance,
        "precisionRefrain": round(precision, 4),
        "rappelRefrain": round(recall, 4),
        "vraisPositifs": total_hits,
        "detections": total_detected,
        "attendus": total_expected,
        "silences": {
            "attendus": silence_total,
            "trouves": silence_ok,
            "morceauxSansSilence": no_silence_total,
            "sansFauxSilence": no_silence_ok,
        },
        "tracks": rows,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    print(f"Précision refrain : {precision:.1%} ({total_hits}/{total_detected})")
    print(f"Rappel refrain    : {recall:.1%} ({total_hits}/{total_expected})")
    print(
        f"Silences          : {silence_ok}/{silence_total} trouvés ; "
        f"{no_silence_ok}/{no_silence_total} morceaux sans faux silence"
    )
    print()
    for row in rows:
        print(
            f"{row['titre'][:30]:30s} {row['sections']:3d} sections  "
            f"attendu={row['attendus']} détecté={row['detectes']}  "
            f"{row['analysisSec']:.1f}s"
        )
        for problem in row["violations"]:
            print(f"  ⚠ {problem}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
