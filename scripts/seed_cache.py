"""Pré-remplit le cache audio du serveur avec des fichiers locaux.

Un fichier enregistré ici est utilisé tel quel quand le lecteur annonce le même
titre et le même artiste : plus besoin de le déposer à la main à chaque écoute,
et le morceau n'est jamais redemandé à Deezer.

    uv run python scripts/seed_cache.py "/home/mattia/Σ. MOROSE (LIVE).mp3"
    uv run python scripts/seed_cache.py --dir ~/Musique/lives --replace
    uv run python scripts/seed_cache.py --dry-run fichier.mp3

Le cache utilisé est celui du serveur (`CACHE_DIR`, sinon
`~/.local/share/night-light/cache`) : passer `--cache-dir` seulement pour une
instance qui tourne avec un autre répertoire.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.config import load_settings  # noqa: E402
from server.retrieve.cache import AudioCache  # noqa: E402
from server.retrieve.seed import SeedError, build_query, seed_track  # noqa: E402

AUDIO_SUFFIXES = {
    ".mp3",
    ".m4a",
    ".aac",
    ".flac",
    ".ogg",
    ".opus",
    ".aiff",
    ".aif",
    ".wav",
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Pré-remplit le cache audio avec des fichiers locaux.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("files", nargs="*", type=Path, help="fichiers audio à enregistrer")
    parser.add_argument(
        "--dir",
        action="append",
        default=[],
        metavar="REPERTOIRE",
        help="ajoute tous les fichiers audio d'un répertoire (récursif)",
    )
    parser.add_argument(
        "--cache-dir", type=Path, default=None, help="cache cible (défaut: serveur)"
    )
    parser.add_argument("--title", help="force le titre (un seul fichier)")
    parser.add_argument("--artist", help="force l'artiste (un seul fichier)")
    parser.add_argument(
        "--duration", type=float, help="force la durée en secondes si elle est illisible"
    )
    parser.add_argument("--replace", action="store_true", help="écrase une entrée déjà présente")
    parser.add_argument("--dry-run", action="store_true", help="affiche sans écrire")
    parser.add_argument("--json", action="store_true", help="sortie JSON")
    return parser


def _collect(files: list[Path], directories: list[str]) -> list[Path]:
    collected: list[Path] = []
    for file in files:
        collected.append(file.expanduser().resolve())
    for raw in directories:
        directory = Path(raw).expanduser().resolve()
        if not directory.is_dir():
            raise SeedError(f"répertoire introuvable: {directory}")
        for candidate in sorted(directory.rglob("*")):
            if candidate.is_file() and candidate.suffix.lower() in AUDIO_SUFFIXES:
                collected.append(candidate)
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in collected:
        if path in seen:
            continue
        seen.add(path)
        unique.append(path)
    if not unique:
        raise SeedError("aucun fichier fourni (arguments ou --dir)")
    return unique


def _entry_payload(entry, query, path: Path) -> dict[str, object]:
    return {
        "fichier": str(path),
        "titre": query.title,
        "artiste": query.artist,
        "dureeSec": round(query.duration_sec, 3),
        "cacheCle": entry.key,
        "cacheChemin": str(entry.path),
        "octets": entry.size_bytes,
    }


def run() -> int:
    args = _parser().parse_args()
    try:
        paths = _collect(args.files, args.dir)
    except SeedError as error:
        print(f"erreur: {error}", file=sys.stderr)
        return 2
    if len(paths) > 1 and (args.title or args.artist or args.duration):
        print(
            "erreur: --title/--artist/--duration ne valent que pour un seul fichier",
            file=sys.stderr,
        )
        return 2

    cache_dir = (
        args.cache_dir.expanduser().resolve() if args.cache_dir else Path(load_settings().cache_dir)
    )
    cache = AudioCache(cache_dir)
    rows: list[dict[str, object]] = []
    failures = 0
    for path in paths:
        try:
            query = build_query(
                path,
                title=args.title,
                artist=args.artist,
                duration_sec=args.duration,
            )
            entry = seed_track(
                cache,
                path,
                title=args.title,
                artist=args.artist,
                duration_sec=args.duration,
                replace=args.replace,
                dry_run=args.dry_run,
            )
        except SeedError as error:
            failures += 1
            print(f"échec {path.name}: {error}", file=sys.stderr)
            continue
        rows.append(_entry_payload(entry, query, path))
        if not args.json:
            prefix = "simulé" if args.dry_run else "ajouté"
            print(
                f"{prefix} {query.artist or '(sans artiste)'} — {query.title} "
                f"[{query.duration_sec:.3f}s] <- {path}"
            )

    if args.json:
        print(json.dumps({"cache": str(cache_dir), "entrees": rows}, ensure_ascii=False, indent=2))
    elif not args.dry_run:
        print(f"\ncache: {cache_dir} ({len(rows)} entrée(s))")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(run())
