import json
import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from server.retrieve.deezer import (
    DEEZER_QUALITY,
    DeezerProvider,
    DeezerProviderError,
    _build_query,
    _candidate_from_result,
    _error_detail,
    _parse_desc,
    _set_option,
    _toml_string,
)
from server.retrieve.models import Candidate, TrackQuery
from tests.make_fixture import write_synthetic_track


def _streamrip_installed() -> bool:
    return bool(
        shutil.which("streamrip")
        or (Path.home() / ".local" / "bin" / "streamrip").is_file()
    )


@pytest.fixture()
def provider(tmp_path: Path) -> DeezerProvider:
    return DeezerProvider(arl="arl-test", work_dir=tmp_path / "streamrip")


def _fake_search_run(results: list[dict]) -> object:
    def run(
        command, *, timeout: int, operation: str
    ) -> subprocess.CompletedProcess[str]:
        output = Path(command[command.index("--output-file") + 1])
        output.write_text(json.dumps(results), encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, "", "")

    return run


def _fake_download_run(duration: float = 12.0, write_file: bool = True) -> object:
    def run(
        command, *, timeout: int, operation: str
    ) -> subprocess.CompletedProcess[str]:
        destination = Path(command[command.index("-f") + 1])
        destination.mkdir(parents=True, exist_ok=True)
        if write_file:
            write_synthetic_track(
                destination / "01. Daft Punk - Get Lucky.wav", duration=duration
            )
        return subprocess.CompletedProcess(command, 0, "", "")

    return run


def test_parse_desc_splits_title_and_artist() -> None:
    assert _parse_desc("Get Lucky by Daft Punk (2013)") == ("Get Lucky", "Daft Punk")
    assert _parse_desc("Instant Crush by Daft Punk, Julian Casablancas (2013)") == (
        "Instant Crush",
        "Daft Punk, Julian Casablancas",
    )


def test_parse_desc_keeps_a_title_containing_by() -> None:
    title, artist = _parse_desc("Stand by Me by Ben E. King (1961, explicit)")
    assert (title, artist) == ("Stand by Me", "Ben E. King")


def test_parse_desc_without_artist() -> None:
    assert _parse_desc("Some Instrumental (2019)") == ("Some Instrumental", "")


def test_candidate_from_result_maps_deezer_fields() -> None:
    query = TrackQuery(title="Get Lucky", artist="Daft Punk", duration_sec=369.0)
    candidate = _candidate_from_result(
        {
            "source": "deezer",
            "media_type": "track",
            "id": "123",
            "desc": "Get Lucky by Daft Punk (2013)",
        },
        query,
    )
    assert candidate is not None
    assert candidate.provider == "deezer"
    assert candidate.source_id == "123"
    assert candidate.title == "Get Lucky"
    assert candidate.artist == "Daft Punk"
    assert candidate.url == "https://www.deezer.com/track/123"
    assert candidate.bitrate == 128
    # streamrip ne donne pas la durée : la requête la porte pour la vérification.
    assert candidate.duration_sec is None
    assert candidate.metadata["expected_duration_sec"] == 369.0
    assert candidate.metadata["quality"] == DEEZER_QUALITY


@pytest.mark.parametrize(
    "item",
    [
        {},
        {"id": "1"},
        {"desc": "Get Lucky by Daft Punk (2013)"},
        {"id": "1", "desc": ""},
        "not a dict",
    ],
)
def test_candidate_from_result_rejects_incomplete_items(item) -> None:
    assert _candidate_from_result(item, TrackQuery(title="x")) is None


def test_build_query_joins_title_and_artist() -> None:
    query = TrackQuery(title="Get Lucky", artist="Daft Punk, Pharrell & Nile")
    assert _build_query(query) == "Get Lucky Daft Punk Pharrell Nile"


def test_set_option_replaces_value_in_section() -> None:
    text = '[deezer]\nquality = 2\narl = ""\n\n[cli]\nprogress_bars = true\n'
    updated = _set_option(text, "deezer", "arl", '"abc"')
    assert 'arl = "abc"' in updated
    assert "quality = 2" in updated


def test_set_option_uncomments_an_option() -> None:
    text = "[cli]\nprogress_bars = true\n# no_update_check = true\n"
    assert "no_update_check = true" in _set_option(
        text, "cli", "no_update_check", "true"
    )


def test_set_option_inserts_a_missing_option() -> None:
    text = "[database]\ndownloads_enabled = true\n\n[cli]\nprogress_bars = true\n"
    updated = _set_option(text, "database", "failed_downloads_enabled", "false")
    assert "failed_downloads_enabled = false" in updated
    # La valeur reste dans sa section.
    assert updated.index("failed_downloads_enabled") < updated.index("[cli]")


def test_set_option_rejects_unknown_section() -> None:
    with pytest.raises(DeezerProviderError):
        _set_option('[deezer]\narl = ""\n', "nowhere", "arl", '"x"')


def test_toml_string_refuses_quotes() -> None:
    assert _toml_string("abc") == '"abc"'
    with pytest.raises(DeezerProviderError):
        _toml_string('a"b')


def test_error_detail_keeps_the_useful_line() -> None:
    stderr = (
        "│ Some decorated frame line                        │\n"
        "╰──────────────────────────────────────────────────╯\n"
        "AuthenticationError: deezer needs authorising again.\n"
    )
    assert (
        _error_detail(stderr, "")
        == "AuthenticationError: deezer needs authorising again."
    )
    assert _error_detail("", "") == "erreur inconnue"


def test_provider_requires_an_arl(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        DeezerProvider(arl="", work_dir=tmp_path)


def test_search_maps_results_and_downloads_at_lowest_quality(
    provider: DeezerProvider,
) -> None:
    results = [
        {
            "source": "deezer",
            "media_type": "track",
            "id": "9",
            "desc": "Something Else by X (1999)",
        },
        {
            "source": "deezer",
            "media_type": "track",
            "id": "7",
            "desc": "Get Lucky by Daft Punk (2013)",
        },
        {
            "source": "deezer",
            "media_type": "track",
            "id": "7",
            "desc": "Get Lucky by Daft Punk (2013)",
        },
    ]
    commands: list[list[str]] = []

    def run(command, *, timeout: int, operation: str):
        commands.append(command)
        return _fake_search_run(results)(command, timeout=timeout, operation=operation)

    with (
        patch(
            "server.retrieve.deezer.DeezerProvider._config",
            return_value=Path("/tmp/c.toml"),
        ),
        patch("server.retrieve.deezer._run_command", side_effect=run),
    ):
        candidates = provider.search(
            TrackQuery(title="Get Lucky", artist="Daft Punk", duration_sec=369.0)
        )

    assert [candidate.source_id for candidate in candidates] == ["7", "9"]
    command = commands[0]
    assert command[1:3] == ["--config-path", "/tmp/c.toml"]
    # Le niveau de qualité le plus bas est demandé, pas le plus haut.
    assert command[command.index("--quality") + 1] == str(DEEZER_QUALITY) == "0"
    assert command[command.index("deezer") : command.index("deezer") + 2] == [
        "deezer",
        "track",
    ]


def test_search_without_results_returns_nothing(provider: DeezerProvider) -> None:
    def run(
        command, *, timeout: int, operation: str
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 0, "No search results found", "")

    with (
        patch(
            "server.retrieve.deezer.DeezerProvider._config",
            return_value=Path("/tmp/c.toml"),
        ),
        patch("server.retrieve.deezer._run_command", side_effect=run),
    ):
        assert provider.search(TrackQuery(title="Inconnu")) == []


def test_search_reports_an_unreadable_answer(provider: DeezerProvider) -> None:
    def run(
        command, *, timeout: int, operation: str
    ) -> subprocess.CompletedProcess[str]:
        Path(command[command.index("--output-file") + 1]).write_text("pas du json")
        return subprocess.CompletedProcess(command, 0, "", "")

    with (
        patch(
            "server.retrieve.deezer.DeezerProvider._config",
            return_value=Path("/tmp/c.toml"),
        ),
        patch("server.retrieve.deezer._run_command", side_effect=run),
        pytest.raises(DeezerProviderError),
    ):
        provider.search(TrackQuery(title="Get Lucky"))


def test_download_accepts_a_matching_track(
    provider: DeezerProvider, tmp_path: Path
) -> None:
    candidate = Candidate(
        provider="deezer",
        source_id="7",
        title="Get Lucky",
        artist="Daft Punk",
        metadata={"expected_duration_sec": 12.0},
    )
    commands: list[list[str]] = []

    def run(command, *, timeout: int, operation: str):
        commands.append(command)
        return _fake_download_run(duration=12.0)(
            command, timeout=timeout, operation=operation
        )

    with (
        patch(
            "server.retrieve.deezer.DeezerProvider._config",
            return_value=Path("/tmp/c.toml"),
        ),
        patch("server.retrieve.deezer._run_command", side_effect=run),
    ):
        path = provider.download(candidate, tmp_path / "out")

    assert path.is_file()
    command = commands[0]
    assert command[command.index("--quality") + 1] == "0"
    assert command[command.index("id") :] == ["id", "deezer", "track", "7"]
    assert command[command.index("-f") + 1] == str(tmp_path / "out")


def test_download_rejects_a_different_version(
    provider: DeezerProvider, tmp_path: Path
) -> None:
    candidate = Candidate(
        provider="deezer",
        source_id="7",
        title="Get Lucky",
        artist="Daft Punk",
        metadata={"expected_duration_sec": 60.0},
    )
    with (
        patch(
            "server.retrieve.deezer.DeezerProvider._config",
            return_value=Path("/tmp/c.toml"),
        ),
        patch(
            "server.retrieve.deezer._run_command",
            side_effect=_fake_download_run(duration=12.0),
        ),
        pytest.raises(DeezerProviderError) as error,
    ):
        provider.download(candidate, tmp_path / "out")
    assert "durée incompatible" in str(error.value)


def test_download_without_a_file_is_reported(
    provider: DeezerProvider, tmp_path: Path
) -> None:
    candidate = Candidate(provider="deezer", source_id="7", title="Get Lucky")
    with (
        patch(
            "server.retrieve.deezer.DeezerProvider._config",
            return_value=Path("/tmp/c.toml"),
        ),
        patch(
            "server.retrieve.deezer._run_command",
            side_effect=_fake_download_run(write_file=False),
        ),
        pytest.raises(DeezerProviderError) as error,
    ):
        provider.download(candidate, tmp_path / "out")
    assert "aucun fichier audio" in str(error.value)


def test_download_without_identifier_is_reported(
    provider: DeezerProvider, tmp_path: Path
) -> None:
    candidate = Candidate(provider="deezer", source_id="", title="Get Lucky")
    with pytest.raises(DeezerProviderError):
        provider.download(candidate, tmp_path)


@pytest.mark.skipif(not _streamrip_installed(), reason="streamrip n'est pas installé")
def test_generated_config_carries_the_arl_and_the_lowest_quality(
    provider: DeezerProvider,
) -> None:
    config = provider._config()
    assert config.is_file()
    assert config.stat().st_mode & 0o777 == 0o600
    text = config.read_text(encoding="utf-8")
    assert 'arl = "arl-test"' in text
    assert "no_update_check = true" in text
    assert "lyrics = false" in text
    assert "downloads_enabled = false" in text
    assert "save_artwork = false" in text
