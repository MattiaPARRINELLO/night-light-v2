"""Client Groq minimal (API compatible OpenAI), sans dépendance ajoutée.

La clé n'est lue que côté serveur, dans `GROQ_API_KEY`. Elle ne doit jamais
être journalisée ni envoyée au navigateur.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "llama-3.1-8b-instant"
DEFAULT_TIMEOUT_SEC = 20.0

Poster = Callable[[str, dict[str, str], bytes], dict[str, Any]]


class GroqError(Exception):
    """Erreur de communication avec Groq."""


class GroqNotConfigured(GroqError):
    """Aucune clé API n'est disponible."""


def _http_post_json(
    url: str, headers: dict[str, str], body: bytes, *, timeout_sec: float = DEFAULT_TIMEOUT_SEC
) -> dict[str, Any]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "ignore")[:200]
        raise GroqError(f"Groq HTTP {error.code}: {detail}") from error
    except (OSError, ValueError) as error:
        raise GroqError(f"Groq inaccessible: {error}") from error
    return payload if isinstance(payload, dict) else {}


class GroqClient:
    """Un seul usage : obtenir une réponse JSON courte depuis un modèle rapide."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        model: str = DEFAULT_MODEL,
        base_url: str = DEFAULT_BASE_URL,
        timeout_sec: float = DEFAULT_TIMEOUT_SEC,
        poster: Poster | None = None,
    ) -> None:
        self.api_key = (
            api_key if api_key is not None else os.environ.get("GROQ_API_KEY", "")
        ).strip()
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout_sec = timeout_sec
        self._poster = poster

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def complete_json(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int = 1_200,
    ) -> dict[str, Any]:
        """Envoie une conversation et renvoie l'objet JSON de la réponse."""
        if not self.api_key:
            raise GroqNotConfigured("GROQ_API_KEY est absente")
        body = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
            }
        ).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        post = self._poster or (
            lambda url, headers, body: _http_post_json(
                url, headers, body, timeout_sec=self.timeout_sec
            )
        )
        payload = post(f"{self.base_url}/chat/completions", headers, body)

        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise GroqError("réponse Groq sans choix")
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise GroqError("réponse Groq vide")
        try:
            parsed = json.loads(content)
        except ValueError as error:
            raise GroqError("réponse Groq non JSON") from error
        if not isinstance(parsed, dict):
            raise GroqError("réponse Groq inattendue")
        return parsed
