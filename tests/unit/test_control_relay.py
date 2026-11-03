"""Relais du canal de contrôle entre appareils.

Le téléphone et l'écran de projection ne partagent pas de `BroadcastChannel` :
ce relais WebSocket est le seul pont. Ces tests vérifient la diffusion croisée
et le rejet des messages démesurés.
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.relay import MAX_MESSAGE_CHARS, attach_control_relay


def make_client() -> TestClient:
    app = FastAPI()
    attach_control_relay(app)
    return TestClient(app)


def test_relay_broadcasts_between_two_clients() -> None:
    with (
        make_client() as client,
        client.websocket_connect("/api/control") as phone,
        client.websocket_connect("/api/control") as ecran,
    ):
        phone.send_text('{"type":"set-effect"}')
        assert ecran.receive_text() == '{"type":"set-effect"}'

        ecran.send_text('{"type":"state"}')
        assert phone.receive_text() == '{"type":"state"}'


def test_relay_ignores_oversized_messages() -> None:
    with (
        make_client() as client,
        client.websocket_connect("/api/control") as phone,
        client.websocket_connect("/api/control") as ecran,
    ):
        phone.send_text("x" * (MAX_MESSAGE_CHARS + 1))
        phone.send_text('{"ok":true}')
        assert ecran.receive_text() == '{"ok":true}'


def test_relay_survives_a_departure() -> None:
    with make_client() as client, client.websocket_connect("/api/control") as phone:
        with client.websocket_connect("/api/control") as ecran:
            phone.send_text('{"first":1}')
            assert ecran.receive_text() == '{"first":1}'
        # L'écran est parti ; un nouveau client doit pouvoir se brancher.
        with client.websocket_connect("/api/control") as nouveau:
            phone.send_text('{"second":2}')
            assert nouveau.receive_text() == '{"second":2}'
