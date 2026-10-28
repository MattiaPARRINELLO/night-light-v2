"""Liste les drops de production de chaque titre du corpus réel.

Lit les analyses déjà calculées (``tests/fixtures/analyses/real-<id>.json``) et
le manifeste, puis affiche un tableau stable : titre, nombre de drops et
horodatages. Aucun réseau, aucun audio.

    uv run python tools/drop-list.py
    uv run python tools/drop-list.py --json /tmp/opencode/drops.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "tests/support/real_corpus.json"
DEFAULT_ANALYSES = ROOT / "tests/fixtures/analyses"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--analyses", type=Path, default=DEFAULT_ANALYSES)
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    rows = []
    for entry in manifest:
        path = args.analyses / f"real-{int(entry['id'])}.json"
        if not path.is_file():
            rows.append({"titre": entry["titre"], "id": entry["id"], "drops": None})
            continue
        analysis = json.loads(path.read_text(encoding="utf-8"))
        drops = [round(float(drop["time"]), 3) for drop in analysis.get("drops", [])]
        rows.append({"titre": entry["titre"], "id": entry["id"], "drops": drops})

    print("| morceau | drops | horodatages (s) |")
    print("|---|---:|---|")
    for row in rows:
        drops = row["drops"]
        if drops is None:
            print(f"| {row['titre']} | — | analyse absente |")
            continue
        stamps = ", ".join(f"{value:.2f}" for value in drops) or "—"
        print(f"| {row['titre']} | {len(drops)} | {stamps} |")

    if args.json is not None:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
