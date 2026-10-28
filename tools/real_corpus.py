"""Télécharge et analyse le corpus réel décrit par `tests/support/real_corpus.json`.

Le téléchargement passe par l'outil Deezer **du projet** (`server.retrieve` :
recherche catalogue + `streamrip`), jamais par un client réécrit ici. Le cache
audio est celui du serveur (`~/.local/share/night-light/cache` par défaut), donc
un morceau déjà présent n'est pas retéléchargé.

Le cookie Deezer n'est jamais affiché ni écrit : il est lu depuis
`DEEZER_ARL` ou, à défaut, depuis la configuration streamrip déjà en cache.

Usage :
    uv run python tools/real_corpus.py                 # télécharge + analyse
    uv run python tools/real_corpus.py --sync-durations # met à jour les durées
    uv run python tools/real_corpus.py --no-download    # analyse le cache seul

Les analyses vont dans `tests/fixtures/analyses/real-<id>.json` (ignoré par
git), avec un index `real-index.json`. Aucun fichier audio n'est versionné.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.analysis import AnalysisResult, analyze_file  # noqa: E402
from server.config import load_settings  # noqa: E402
from server.retrieve import (  # noqa: E402
    AudioCache,
    DeezerProvider,
    TrackQuery,
    resolve_track,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "tests/support/real_corpus.json"
DEFAULT_ANALYSIS_DIR = ROOT / "tests/fixtures/analyses"


def to_schema(result: AnalysisResult) -> dict:
    """Même projection que `server.main.to_schema` et `make_corpus.py`."""
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
        **({"coverage": list(result.coverage)} if result.coverage is not None else {}),
    }


def read_arl(cache_dir: Path) -> str:
    """Cookie Deezer : variable d'environnement puis config streamrip en cache."""
    import os
    import tomllib

    env = (os.environ.get("DEEZER_ARL") or "").strip()
    if env:
        return env
    config = cache_dir / "streamrip" / "streamrip.toml"
    if config.is_file():
        try:
            payload = tomllib.loads(config.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return ""
        return str((payload.get("deezer") or {}).get("arl") or "").strip()
    return ""


def load_manifest(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list) or not payload:
        raise SystemExit(f"manifeste vide ou invalide : {path}")
    return payload


def write_manifest(path: Path, entries: list[dict]) -> None:
    ordered = sorted(
        (
            {
                "artiste": str(entry["artiste"]),
                "durée": round(float(entry["durée"]), 1),
                "id": int(entry["id"]),
                "meter_attendu": int(entry.get("meter_attendu", 4)),
                "profil": str(entry["profil"]),
                **({"reference": True} if entry.get("reference") is True else {}),
                "titre": str(entry["titre"]),
            }
            for entry in entries
        ),
        key=lambda entry: entry["id"],
    )
    path.write_text(
        json.dumps(ordered, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--cache-dir", type=Path, default=None)
    parser.add_argument("--analysis-dir", type=Path, default=DEFAULT_ANALYSIS_DIR)
    parser.add_argument("--no-download", action="store_true")
    parser.add_argument("--sync-durations", action="store_true")
    args = parser.parse_args()

    settings = load_settings()
    cache_dir = args.cache_dir or Path(settings.cache_dir)
    cache = AudioCache(cache_dir)
    entries = load_manifest(args.manifest)
    args.analysis_dir.mkdir(parents=True, exist_ok=True)

    provider: DeezerProvider | None = None
    arl = read_arl(cache_dir)
    index: list[dict] = []

    for entry in entries:
        track_id = int(entry["id"])
        title = str(entry["titre"])
        artist = str(entry["artiste"])
        profile = str(entry["profil"])
        expected_meter = int(entry.get("meter_attendu", 4))
        if expected_meter not in (3, 4):
            raise SystemExit(f"meter_attendu invalide pour {title}: {expected_meter}")
        # Durée 0 dans la requête : c'est la clé de cache historique du projet.
        query = TrackQuery(title=title, artist=artist, duration_sec=0.0)
        cached = cache.get_entry_for_query(query)
        from_cache = cached is not None
        if cached is None:
            if args.no_download:
                raise SystemExit(f"absent du cache et --no-download : {title} ({track_id})")
            if provider is None:
                if not arl:
                    raise SystemExit(
                        "cookie Deezer absent : renseigner DEEZER_ARL ou lancer "
                        "l'application une fois pour créer le cache streamrip"
                    )
                provider = DeezerProvider(arl=arl)
            candidates = provider.search(query)
            match = next(
                (candidate for candidate in candidates if candidate.source_id == str(track_id)),
                None,
            )
            if match is None:
                raise SystemExit(f"identifiant {track_id} absent des résultats Deezer pour {title}")
            result = resolve_track(query, provider, cache, preselected=[match])
            cached = cache.get_entry_for_query(query)
            if cached is None:
                raise SystemExit(f"téléchargement sans entrée de cache : {title}")
            audio_path = result.cache_entry_path
        else:
            audio_path = cached.path

        analysis_path = args.analysis_dir / f"real-{track_id}.json"
        if (
            not analysis_path.is_file()
            or analysis_path.stat().st_mtime < audio_path.stat().st_mtime
        ):
            result = analyze_file(audio_path, settings)
            schema = to_schema(result)
            analysis_path.write_text(
                json.dumps(schema, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
        else:
            schema = json.loads(analysis_path.read_text(encoding="utf-8"))

        duration = float(schema["duration"])
        builds = len(schema.get("builds") or [])
        index.append(
            {
                "id": track_id,
                "titre": title,
                "artiste": artist,
                "profil": profile,
                "meter_attendu": expected_meter,
                "durée": round(duration, 1),
                "analysis": analysis_path.name,
                "source": "cache" if from_cache else "téléchargé",
                "tempo": schema["tempo"],
                "meter": schema.get("meter", 4),
                "builds": builds,
            }
        )
        print(
            f"{title[:38]:38s} | {profile[:26]:26s} | {duration:6.1f} s | "
            f"{schema['tempo']:6.1f} BPM | {schema.get('meter', 4)}/4 | "
            f"{builds} montée(s) | {index[-1]['source']}",
            flush=True,
        )
        if args.sync_durations:
            entry["durée"] = round(duration, 1)

    (args.analysis_dir / "real-index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if args.sync_durations:
        write_manifest(args.manifest, entries)
        print(f"manifeste mis à jour : {args.manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
