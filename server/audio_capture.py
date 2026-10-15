"""Capture audio système locale via PipeWire/PulseAudio pour Night Light."""

from __future__ import annotations

import contextlib
import math
import shutil
import struct
import subprocess
import threading
import time
from dataclasses import asdict, dataclass
from typing import Any

SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK_BYTES = 2048
SILENCE_RMS_THRESHOLD = 0.006
SILENCE_STATE_SEC = 1.5


@dataclass
class AudioLevel:
    active: bool = False
    available: bool = False
    state: str = "inactive"  # inactive, starting, active, silent, error
    rms: float = 0.0
    energy: float = 0.0
    bass: float = 0.0
    mid: float = 0.0
    high: float = 0.0
    transient: float = 0.0
    source: str = ""
    error: str = ""
    updated_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class SystemAudioCapture:
    """Capture le moniteur de sortie du système et expose des caractéristiques lissées."""

    def __init__(self) -> None:
        self._proc: subprocess.Popen[bytes] | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._clients = 0
        self._level = AudioLevel()
        self._available_checked = False
        self._available = False
        self._silent_since: float | None = None

    def available(self) -> bool:
        if self._available_checked:
            return self._available
        self._available_checked = True
        self._available = (
            shutil.which("parec") is not None and shutil.which("pactl") is not None
        )
        self._level.available = self._available
        if not self._available:
            self._level.state = "error"
            self._level.error = "parec/pactl indisponible"
        return self._available

    def _default_monitor(self) -> str:
        # Priorité au sink par défaut : c'est généralement celui que l'utilisateur entend.
        try:
            sink = subprocess.run(
                ["pactl", "get-default-sink"],
                capture_output=True,
                text=True,
                timeout=2.0,
                check=False,
            ).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            sink = ""
        if sink:
            return f"{sink}.monitor"
        # Sinon, préférer un sink réellement en lecture.
        try:
            result = subprocess.run(
                ["pactl", "list", "sinks", "short"],
                capture_output=True,
                text=True,
                timeout=2.0,
                check=False,
            )
            for line in result.stdout.splitlines():
                fields = line.split()
                if len(fields) < 6:
                    continue
                name = fields[1]
                state = fields[-1]
                if state.upper().startswith("RUNNING"):
                    return f"{name}.monitor"
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass
        return ""

    def acquire(self) -> None:
        with self._lock:
            self._clients += 1
            if self._clients == 1:
                self._start_locked()

    def release(self) -> None:
        with self._lock:
            if self._clients > 0:
                self._clients -= 1
            if self._clients == 0:
                self._stop_locked()

    def level(self) -> AudioLevel:
        with self._lock:
            clients = self._clients
        if clients > 0:
            self._ensure_started()
        with self._lock:
            return AudioLevel(**self._level.to_dict())

    def _ensure_started(self) -> None:
        with self._lock:
            proc_dead = self._proc is not None and self._proc.poll() is not None
            need = proc_dead or self._proc is None
            if not need:
                return
            self._stop.clear()
            self._start_locked()

    def _start_locked(self) -> None:
        if not self.available():
            self._level = AudioLevel(
                active=False,
                available=False,
                state="error",
                error="parec/pactl indisponible",
            )
            return
        self._stop.clear()
        source = self._default_monitor()
        command = [
            "parec",
            "--device",
            source if source else "@DEFAULT_MONITOR@",
            f"--rate={SAMPLE_RATE}",
            f"--channels={CHANNELS}",
            "--format=s16le",
        ]
        try:
            self._proc = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )
        except OSError as error:
            self._level = AudioLevel(
                active=False,
                available=self._available,
                state="error",
                error=str(error),
            )
            self._proc = None
            return
        self._level = AudioLevel(
            active=True,
            available=True,
            state="active",
            source=source or "default monitor",
            updated_at=time.time(),
        )
        self._silent_since = None
        self._thread = threading.Thread(
            target=self._read_loop, name="system-audio-capture", daemon=True
        )
        self._thread.start()

    def _stop_locked(self) -> None:
        self._stop.set()
        if self._proc is not None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=2.0)
            except (OSError, subprocess.TimeoutExpired):
                with contextlib.suppress(OSError):
                    self._proc.kill()
            self._proc = None
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None
        self._stop.clear()
        self._silent_since = None
        self._level = AudioLevel(
            active=False, available=self._available, state="inactive", updated_at=time.time()
        )

    def _read_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        while not self._stop.is_set():
            chunk = proc.stdout.read(CHUNK_BYTES)
            if not chunk:
                break
            if len(chunk) < 2:
                continue
            count = len(chunk) // 2
            samples = struct.unpack(f"<{count}h", chunk[: count * 2])
            square = sum(sample * sample for sample in samples)
            rms = math.sqrt(square / count) / 32768.0 if count else 0.0
            energy = rms
            transient = 0.0
            bass = mid = high = 0.0
            try:
                import numpy as np

                array = np.asarray(samples, dtype=np.float32) / 32768.0
                n = min(512, len(array))
                if n >= 32:
                    spectrum = np.abs(np.fft.rfft(array[-n:], n=n))
                    freqs = np.fft.rfftfreq(n, d=1.0 / SAMPLE_RATE)
                    energy_low = (
                        float(np.mean(spectrum[(freqs >= 20) & (freqs < 250)]))
                        if np.any((freqs >= 20) & (freqs < 250))
                        else 0.0
                    )
                    energy_mid = (
                        float(np.mean(spectrum[(freqs >= 250) & (freqs < 2000)]))
                        if np.any((freqs >= 250) & (freqs < 2000))
                        else 0.0
                    )
                    energy_high = (
                        float(np.mean(spectrum[freqs >= 2000]))
                        if np.any(freqs >= 2000)
                        else 0.0
                    )
                    total = energy_low + energy_mid + energy_high
                    if total > 0:
                        bass = energy_low / total
                        mid = energy_mid / total
                        high = energy_high / total
                    with self._lock:
                        previous_energy = self._level.energy
                    transient = max(0.0, energy - previous_energy)
                    transient = min(1.0, transient * 4.0)
            except Exception:
                bass = mid = high = 0.0
            with self._lock:
                self._level.rms = self._level.rms * 0.35 + rms * 0.65
                self._level.energy = self._level.energy * 0.35 + energy * 0.65
                self._level.bass = self._level.bass * 0.4 + bass * 0.6
                self._level.mid = self._level.mid * 0.4 + mid * 0.6
                self._level.high = self._level.high * 0.4 + high * 0.6
                self._level.transient = self._level.transient * 0.3 + transient * 0.7
                self._level.active = True
                self._level.updated_at = time.time()
                if self._level.rms < SILENCE_RMS_THRESHOLD:
                    if self._silent_since is None:
                        self._silent_since = time.time()
                    elif time.time() - self._silent_since >= SILENCE_STATE_SEC:
                        self._level.state = "silent"
                else:
                    self._silent_since = None
                    self._level.state = "active"
        with self._lock:
            if self._level.active:
                self._level.active = False
            if self._proc is not None and self._proc.poll() is not None and not self._stop.is_set():
                self._level.state = "error"
                self._level.error = "Capture interrompue"
            else:
                if self._level.state not in {"silent", "error"}:
                    self._level.state = "inactive"


_CAPTURE = SystemAudioCapture()


def get_audio_capture() -> SystemAudioCapture:
    return _CAPTURE
