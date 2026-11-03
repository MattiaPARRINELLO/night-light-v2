"""Relais du canal de contrôle entre appareils.

Le tableau de bord et l'écran de show vivent normalement dans le même
navigateur, où `BroadcastChannel` suffit. Depuis un téléphone, il n'y a plus de
canal local : ce relais relaie les messages de contrôle tels quels entre toutes
les pages connectées, sans les interpréter.

Un client n'entend jamais ses propres messages (il les a déjà appliqués
localement) : le relais exclut l'expéditeur de la diffusion.
"""

from __future__ import annotations

import asyncio

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

# Un message porte au plus une analyse complète (courbes comprises) : quelques
# centaines de kilo-octets. Au-delà, c'est une anomalie, on l'ignore.
MAX_MESSAGE_CHARS = 4_000_000


class ControlRelay:
    """Diffusion en étoile des messages de contrôle, sans état applicatif."""

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def join(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.add(websocket)

    async def leave(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(websocket)

    async def broadcast(self, sender: WebSocket, text: str) -> None:
        async with self._lock:
            targets = [client for client in self._clients if client is not sender]
        dead: list[WebSocket] = []
        for client in targets:
            try:
                await client.send_text(text)
            except Exception:  # noqa: BLE001 - un client parti ne doit pas bloquer les autres
                dead.append(client)
        if dead:
            async with self._lock:
                for client in dead:
                    self._clients.discard(client)


def attach_control_relay(app: FastAPI) -> ControlRelay:
    """Ajoute `/api/control` à une application et renvoie son relais."""
    relay = ControlRelay()

    @app.websocket("/api/control")
    async def control_socket(websocket: WebSocket) -> None:
        await websocket.accept()
        await relay.join(websocket)
        try:
            while True:
                text = await websocket.receive_text()
                if len(text) > MAX_MESSAGE_CHARS:
                    continue
                await relay.broadcast(websocket, text)
        except WebSocketDisconnect:
            pass
        finally:
            await relay.leave(websocket)

    return relay
