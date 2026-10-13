"""Interface fournisseur interchangeable pour le retrieval audio."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from .models import Candidate, TrackQuery


@runtime_checkable
class AudioProvider(Protocol):
    """Contrat minimal d'un fournisseur de sources audio."""

    name: str

    def search(self, query: TrackQuery) -> list[Candidate]:
        """Retourne les candidats potentiels pour une requête."""
        ...

    def download(self, candidate: Candidate, destination: Path) -> Path:
        """Télécharge un candidat dans le répertoire indiqué et retourne le fichier."""
        ...
