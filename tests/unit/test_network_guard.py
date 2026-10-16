"""Le serveur refuse de s'exposer sur le réseau : il n'a aucune authentification."""

from __future__ import annotations

from dataclasses import replace

import pytest

from server.config import is_loopback_host, load_settings
from server.main import enforce_network_guard


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1", "[::1]", " 127.0.0.1 "])
def test_loopback_reconnu(host: str) -> None:
    assert is_loopback_host(host)


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.10", "::", "example.com"])
def test_non_loopback_rejete(host: str) -> None:
    assert not is_loopback_host(host)


def test_le_garde_fou_refuse_une_adresse_publique() -> None:
    settings = replace(load_settings(), host="0.0.0.0", allow_network=False)
    with pytest.raises(SystemExit):
        enforce_network_guard(settings)


def test_le_garde_fou_laisse_passer_en_local() -> None:
    settings = replace(load_settings(), host="127.0.0.1", allow_network=False)
    enforce_network_guard(settings)


def test_allow_network_leve_le_garde_fou() -> None:
    settings = replace(load_settings(), host="0.0.0.0", allow_network=True)
    enforce_network_guard(settings)
