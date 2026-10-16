"""Configuration: validation des variables d'environnement et chemins sûrs."""

import math

import pytest

from server.config import load_settings


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity", "nan", "inf"])
def test_valeurs_non_finites_retombent_sur_le_defaut(monkeypatch, value):
    monkeypatch.setenv("MAX_DURATION_SEC", value)
    monkeypatch.setenv("MAX_FILE_MB", value)
    monkeypatch.setenv("ANALYZE_TIMEOUT_SEC", value)
    settings = load_settings()
    assert math.isfinite(settings.max_duration_sec)
    assert math.isfinite(settings.max_file_mb)
    assert math.isfinite(settings.analyze_timeout_sec)
    assert settings.max_duration_sec == 900
    assert settings.max_file_mb == 40
    assert settings.analyze_timeout_sec == 240


def test_entiers_et_flottants_valides(monkeypatch):
    monkeypatch.setenv("MAX_FILE_MB", "12.5")
    monkeypatch.setenv("PORT", "9000.9")
    settings = load_settings()
    assert settings.max_file_bytes == 12 * 1024 * 1024
    assert settings.port == 9000


def test_session_dir_vide_retombe_sur_defaut(monkeypatch):
    monkeypatch.setenv("SESSION_DIR", "")
    settings = load_settings()
    assert settings.session_dir.endswith("night-light-sessions")
