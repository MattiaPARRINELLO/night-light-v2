import shutil
import subprocess
from unittest.mock import patch

from server.audio_capture import SystemAudioCapture


def test_level_is_inactive_without_clients() -> None:
    capture = SystemAudioCapture()
    with patch.object(capture, "available", return_value=False):
        level = capture.level()
    assert level.available is False
    assert level.state in {"inactive", "error"}


def test_acquire_unavailable_sets_error() -> None:
    capture = SystemAudioCapture()
    with patch("server.audio_capture.shutil.which", return_value=None):
        capture.acquire()
        level = capture.level()
        assert level.available is False
        assert level.state == "error"
        assert "parec" in level.error or "pactl" in level.error
        capture.release()


def test_refcount_releases_process() -> None:
    capture = SystemAudioCapture()
    with patch("server.audio_capture.shutil.which", return_value="/usr/bin/fake"):
        with patch("server.audio_capture.subprocess.Popen") as popen:
            popen.return_value.stdout = None
            with patch.object(capture, "_default_monitor", return_value="sink.monitor"):
                capture.acquire()
                assert capture._clients == 1
                capture.release()
                assert capture._clients == 0
    assert capture.level().state in {"inactive", "error"}


def test_default_monitor_prefers_running_sink() -> None:
    capture = SystemAudioCapture()
    def fake_run(args, *extra, **kwargs):
        if args == ["pactl", "get-default-sink"]:
            return subprocess.CompletedProcess(args=args, returncode=0, stdout="alsa_output.pci.monitor\n", stderr="")
        return subprocess.CompletedProcess(
            args=args, returncode=0,
            stdout="1\talsa_output.pci.monitor\tmodule\ts16le\t2ch\t44100Hz\tRUNNING\n",
            stderr="",
        )
    with patch("server.audio_capture.subprocess.run", side_effect=fake_run):
        assert capture._default_monitor() == "alsa_output.pci.monitor.monitor"


def test_level_values_finite() -> None:
    capture = SystemAudioCapture()
    level = capture.level()
    assert level.rms >= 0
    assert level.energy >= 0
    assert 0 <= level.bass <= 1
