"""Install and run the local LaWa workspace with Python and Node.js."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import monotonic, sleep
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
import venv
import webbrowser


ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "pi-agent"
VENV = ROOT / ".venv"
WINDOWS = os.name == "nt"
PYTHON = VENV / ("Scripts/python.exe" if WINDOWS else "bin/python")
LOOPBACK = "127.0.0.1"
LOCAL_HTTP = build_opener(ProxyHandler({}))


def require_program(name: str) -> str:
    executable = shutil.which(name)
    if executable is None:
        raise RuntimeError(f"{name} is missing. Install Node.js 24 with npm and reopen your terminal.")
    return executable


def node_executable() -> str:
    node = require_program("node")
    version = subprocess.check_output([node, "--version"], text=True).strip()
    major = int(version.removeprefix("v").split(".")[0])
    if major < 24:
        raise RuntimeError(f"Node.js 24 or newer is required. Found {version}.")
    return node


def installed() -> bool:
    return PYTHON.is_file() and (AGENT / "node_modules/tsx/package.json").is_file() and (
        AGENT / "web-dist/index.html"
    ).is_file()


def install() -> None:
    if sys.version_info < (3, 11):
        raise RuntimeError("Python 3.11 or newer is required.")
    node_executable()
    npm = require_program("npm.cmd" if WINDOWS else "npm")
    if not PYTHON.is_file():
        print("Creating the project Python environment.", flush=True)
        venv.EnvBuilder(with_pip=True).create(VENV)
    subprocess.run([str(PYTHON), "-m", "pip", "install", "-r", "requirements.txt"], cwd=ROOT, check=True)
    npm_env = dict(os.environ)
    # The bundled CPU runtime is enough for a local workspace.
    npm_env.setdefault("ONNXRUNTIME_NODE_INSTALL_CUDA", "skip")
    subprocess.run([npm, "ci", "--no-audit", "--no-fund", "--include=dev"], cwd=AGENT, env=npm_env, check=True)
    subprocess.run([npm, "run", "web:build"], cwd=AGENT, check=True)


def local_port(port: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        try:
            listener.bind((LOOPBACK, port))
        except OSError as error:
            raise RuntimeError(f"Port {port} is already in use or unavailable. Choose another port.") from error
        return listener.getsockname()[1]


def runtime_env(data: Path, kernel_port: int, web_port: int) -> dict[str, str]:
    # Inherit OS and network settings. Model credentials are configured in the workspace.
    inherited = {
        "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE",
        "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT",
        "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    }
    env = {key: value for key, value in os.environ.items() if key.upper() in inherited}
    env.update(
        PYTHONUTF8="1",
        PYTHONUNBUFFERED="1",
        PI_CODING_AGENT_DIR=str(data / "pi-runtime"),
        PI_OFFLINE="1",
        LEARNING_BOOTSTRAP="empty",
        LEARNING_STATE_PATH=str(data / "learning-state.json"),
        LEARNING_MATERIALS_DIR=str(data / "materials"),
        LEARNING_RETRIEVAL_DIR=str(data / "retrieval"),
        LEARNING_API_BASE_URL=f"http://{LOOPBACK}:{kernel_port}",
        WEB_SESSION_DIR=str(data / "web-sessions"),
        WEB_SESSION_CWD=str(data),
        PROVIDER_SETTINGS_PATH=str(data / "provider-settings.json"),
        PROVIDER_SECRETS_PATH=str(data / "provider-secrets.json"),
        SPEECH_SETTINGS_PATH=str(data / "speech-settings.json"),
        TEACHING_INSTRUCTIONS_PATH=str(data / "teaching-instructions.json"),
        STUDY_TIME_PATH=str(data / "study-time.json"),
        WEB_HOST=LOOPBACK,
        WEB_PORT=str(web_port),
    )
    return env


def wait_ready(process: subprocess.Popen, url: str, name: str) -> None:
    deadline = monotonic() + 75
    while monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"{name} exited during startup. See the output above.")
        try:
            with LOCAL_HTTP.open(url, timeout=2) as response:
                if response.status == 200 and process.poll() is None:
                    return
        except (URLError, TimeoutError, ConnectionError):
            pass
        sleep(0.2)
    raise RuntimeError(f"{name} did not respond at {url}. See the output above.")


def stop(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if WINDOWS:
        # The venv Python launcher can own a child Python process on Windows.
        # Stop the whole process group, with a tree fallback for detached consoles.
        try:
            process.send_signal(signal.CTRL_BREAK_EVENT)
            process.wait(timeout=3)
            return
        except (OSError, subprocess.TimeoutExpired):
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            )
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def start(data: Path, kernel_port: int, web_port: int, *, check: bool = False, open_browser: bool = False) -> None:
    if not installed():
        raise RuntimeError("Run python scripts/bootstrap.py install first.")
    node = node_executable()
    kernel_port = local_port(kernel_port)
    web_port = local_port(web_port)
    if kernel_port == web_port:
        raise RuntimeError("The Kernel and workspace ports must be different.")
    data.mkdir(parents=True, exist_ok=True)
    env = runtime_env(data, kernel_port, web_port)
    process_group = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {}
    kernel_url = f"http://{LOOPBACK}:{kernel_port}"
    web_url = f"http://{LOOPBACK}:{web_port}"
    children = []
    try:
        kernel = subprocess.Popen(
            [str(PYTHON), "-m", "uvicorn", "app.api.main:app", "--host", LOOPBACK, "--port", str(kernel_port)],
            cwd=ROOT, env=env, **process_group,
        )
        children.append(kernel)
        wait_ready(kernel, f"{kernel_url}/api/learning/overview", "Kernel")
        gateway = subprocess.Popen(
            [node, "--import", "tsx", "src/web/gateway.ts"], cwd=AGENT, env=env, **process_group,
        )
        children.append(gateway)
        wait_ready(gateway, f"{web_url}/api/web/health", "Workspace")
        if check:
            with LOCAL_HTTP.open(f"{web_url}/", timeout=5) as page:
                if b'id="learning-workspace"' not in page.read():
                    raise RuntimeError("The workspace page was not served.")
            with LOCAL_HTTP.open(f"{web_url}/api/web/provider-settings", timeout=10) as response:
                settings = json.load(response)
                if settings["active"]["hasApiKey"]:
                    raise RuntimeError("A fresh workspace unexpectedly inherited model credentials.")
            print("LaWa startup check passed with a fresh workspace.", flush=True)
            return
        print(f"\nLaWa is ready at {web_url}\nData directory: {data}\nPress Ctrl+C to stop.", flush=True)
        if open_browser:
            try:
                opened = webbrowser.open(web_url)
            except (OSError, webbrowser.Error):
                opened = False
            if not opened:
                print(f"Open {web_url} in your browser.", flush=True)
        while all(process.poll() is None for process in children):
            sleep(0.5)
        raise RuntimeError("A LaWa service stopped. See the output above.")
    finally:
        for process in reversed(children):
            stop(process)


def parse_port(value: str) -> int:
    port = int(value)
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("choose a port from 1 through 65535")
    return port


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("run", "install", "start", "check"), default="run")
    parser.add_argument("--port", type=parse_port, help="workspace port (default: 8787)")
    parser.add_argument("--kernel-port", type=parse_port, help="local Kernel port (default: 8000)")
    parser.add_argument("--data-dir", type=Path, help="local data directory (default: .lawa/)")
    parser.add_argument("--open", action="store_true", help="open the workspace in your browser after startup")
    args = parser.parse_args()
    try:
        if args.command == "install" or (args.command == "run" and not installed()):
            install()
        if args.command == "check":
            if args.data_dir:
                parser.error("check always uses a temporary data directory")
            with TemporaryDirectory(prefix="lawa-check-") as data:
                start(Path(data), args.kernel_port or 0, args.port or 0, check=True)
        elif args.command in ("run", "start"):
            data = (args.data_dir or ROOT / ".lawa").resolve()
            start(data, args.kernel_port or 8000, args.port or 8787, open_browser=args.open)
    except KeyboardInterrupt:
        print("\nLaWa stopped.", flush=True)
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"LaWa: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
