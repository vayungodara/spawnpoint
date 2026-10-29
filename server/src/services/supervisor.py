"""Independent Java owner. Run in its own systemd/launchd/Windows service.

Never detach children from the service's process containment. The panel is
only an IPC client; losing it does not close the console pipes.
"""
import collections
import hmac
import http.server
import json
import os
from pathlib import Path
import queue
import secrets
import shlex
import signal
import subprocess
import sys
import threading
import time
import uuid

import launchguard

ROOT = Path(os.environ.get("SPAWNPOINT_ROOT", "C:/MinecraftServers" if os.name == "nt" else "/srv/minecraft")).resolve()
DATA = ROOT / "Spawnpoint/data"
HOME = DATA / "runtime"
RECORDS = HOME / "servers"
NODE = os.environ.get("SPAWNPOINT_NODE", "node")
PREPARE = Path(__file__).with_name("nativeprepare.js")
LOCK = threading.RLock()
LIVE = {}
INSTALLING = {}
TOKEN = secrets.token_hex(32)
EXIT = threading.Event()


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    part = path.with_name(path.name + "." + secrets.token_hex(4) + ".part")
    fd = os.open(part, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    part.replace(path)


def record(id):
    if str(uuid.UUID(id)) != id:
        raise ValueError("invalid server id")
    value = json.loads((RECORDS / (id + ".json")).read_bytes())
    if value["schema"] != 1 or value["server_id"] != id:
        raise ValueError("invalid ownership record; recovery required")
    return value


def save(value):
    atomic(RECORDS / (value["server_id"] + ".json"), value)


def held(value):
    """Automatic recovery cannot race a transaction or uncertain publication."""
    id, path = value["server_id"], Path(value["path"])
    for marker in (".spawnpoint-mutation", ".spawnpoint-publication"):
        if (path / marker).exists():
            return marker + " requires recovery"
    maintenance = DATA / "maintenance.json"
    if maintenance.exists() and id in json.loads(maintenance.read_bytes()):
        return "maintenance requires recovery"
    if (DATA / "promotions" / (id + ".json")).exists():
        return "promotion requires the panel"
    if (HOME / "transfers" / (id + ".json")).exists():
        return "ownership transfer requires recovery"
    install = HOME / "installs" / (id + ".json")
    if install.exists() and json.loads(install.read_bytes())["phase"] != "done":
        return "installation is incomplete"
    return None


def run_java(id):
    value = record(id)
    os.chdir(value["path"])
    args = shlex.split(value["execution_command"])
    if len(args) > 2 and args[1] == ".spawnpoint-launch.py":
        # Use the sealed, possibly older guard bytes without rewriting them.
        if os.name == "nt":
            # Windows exec creates a different PID. Keep the tracked guard in
            # this process so poll/kill still refer to its Job's real owner.
            import importlib.util
            spec = importlib.util.spec_from_file_location("sealed_guard", Path.cwd() / args[1])
            guard = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(guard)
            sys.argv = args[1:]
            guard.main()
            return
        os.execv(sys.executable, [sys.executable, *args[1:]])
    # Unsealed new installs still participate in the stopped lifetime fence.
    fence = launchguard.lock_runtime(Path.cwd())
    if (Path.cwd() / ".spawnpoint-mutation").exists():
        raise ValueError("interrupted mutation needs recovery")
    java = Path(args[0]).resolve()
    if not java.is_file() or java.parent.name != "bin" or java.parent.parent.parent != ROOT / "Tools" or not java.parent.parent.name.startswith("jdk-"):
        raise ValueError("native servers require an explicit Tools Java executable")
    print("Spawnpoint: unsealed runtime starting", flush=True)
    if os.name == "nt":
        sys.exit(launchguard.windows_runtime(args, Path.cwd()))
    os.set_inheritable(fence.fileno(), True)
    os.execv(str(java), args)


class Running:
    def __init__(self):
        self.process = None
        self.lines = collections.deque(maxlen=1000)
        self.pending = queue.Queue(maxsize=16)
        self.stop_at = None
        self.starting = True
        self.booted = False
        self.cpu_sample = None

    def send(self, command):
        if not self.process or self.process.poll() is not None:
            raise ValueError("server is not running")
        if not isinstance(command, str) or not command or len(command) > 500 or any(c in command for c in "\r\n\x00"):
            raise ValueError("one console command of at most 500 characters is required")
        self.pending.put_nowait(command)


def drain(id, running):
    # Always drain Java, even with no viewers. Disk and browser queues are
    # independent; oversized lines and retained console files are bounded.
    log = HOME / "logs" / (id + ".log")
    log.parent.mkdir(parents=True, exist_ok=True)
    with running.process.stdout as output:
        while True:
            data = output.readline(16 * 1024)
            if not data:
                break
            line = data.decode("utf-8", "replace").rstrip("\r\n")
            running.booted |= "Spawnpoint: revision " in line or "Spawnpoint: unsealed runtime starting" in line
            with LOCK:
                running.lines.append(line)
            try:
                if log.exists() and log.stat().st_size + len(data) > 8 * 1024 * 1024:
                    log.with_suffix(".log.2").unlink(missing_ok=True)
                    if log.with_suffix(".log.1").exists():
                        log.with_suffix(".log.1").replace(log.with_suffix(".log.2"))
                    log.replace(log.with_suffix(".log.1"))
                with log.open("ab") as stream:
                    stream.write(data)
            except OSError:
                # Missing console evidence is visible, never a publication ACK.
                with LOCK:
                    running.lines.append("Spawnpoint: console disk write failed; live tail only")


def stdin_writer(running):
    while running.process.poll() is None:
        try:
            command = running.pending.get(timeout=0.25)
        except queue.Empty:
            continue
        try:
            running.process.stdin.write((command + "\n").encode("utf-8"))
            running.process.stdin.flush()
        except (OSError, ValueError):
            return


def start(id, automatic=False):
    with LOCK:
        if id in LIVE:
            return
        value = record(id)
        reason = held(value) if automatic else None
        if reason:
            value["blocked"] = reason
            save(value)
            return
        now = int(time.time() * 1000)
        attempts = [at for at in value.get("attempts", []) if now - at < 600_000]
        if automatic and len(attempts) >= 3:
            value["blocked"] = "three starts in ten minutes; owner action required"
            save(value)
            return
        value.update(desired=True, attempts=[*attempts, now] if automatic else [now], blocked=None,
                     attempt={"id": str(uuid.uuid4()), "at": now})
        save(value)  # charge the budget and publish attempt BEFORE spawning
        running = Running()
        LIVE[id] = running
        threading.Thread(target=launch, args=(id, running), daemon=True).start()


def launch(id, running):
    try:
        prepared = subprocess.run([NODE, str(PREPARE), id], capture_output=True, timeout=120)
        if prepared.returncode:
            raise ValueError(prepared.stderr.decode("utf-8", "replace")[-1000:] or "start preparation failed")
        with LOCK:
            value = record(id)
            if not value["desired"] or EXIT.is_set():
                LIVE.pop(id, None)
                return
            running.process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--run", id],
                                               cwd=value["path"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                               stderr=subprocess.STDOUT, bufsize=0)
            running.starting = False
            threading.Thread(target=drain, args=(id, running), daemon=True).start()
            threading.Thread(target=stdin_writer, args=(running,), daemon=True).start()
    except Exception as error:
        with LOCK:
            value = record(id)
            value["blocked"] = str(error)
            save(value)
            LIVE.pop(id, None)


def stop(id, restart=False):
    with LOCK:
        value = record(id)
        value["desired"] = restart
        save(value)  # stop intent survives service death
        running = LIVE.get(id)
        if running:
            running.stop_at = time.monotonic() + 45
            if running.process:
                running.send("stop")


def force_stop(running):
    if os.name == "nt":
        # Killing the guard closes its per-server Job and kills its Java tree.
        running.process.kill()
    else:
        # ponytail: Unix force-kill restarts the whole owner service. Its cgroup
        # (systemd) or job process group (launchd) cleans every descendant; a
        # PID-only kill could leave an escaped child retaining the JVM fence.
        # Other desired servers return through their durable restart budgets.
        os._exit(75)


def orphaned_children():
    """Do not report stopped while a child outlives its tracked Java parent.

    Children never detach from the owner's service. A systemd cgroup also
    includes children that change process groups; launchd retains the job group.
    An orphan or an unavailable process inventory requires full OS cleanup.
    """
    try:
        rows = [line.split() for line in subprocess.check_output(["ps", "-axo", "pid=,ppid=,pgid=,stat="], timeout=3).decode().splitlines()]
        members = {int(pid) for pid, _parent, group, _state in rows if int(group) == os.getpgrp()}
        if sys.platform == "linux":
            cgroup = next((line.split("::", 1)[1] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::")), "")
            if cgroup.endswith("/spawnpoint-supervisor.service"):
                members = {int(pid) for pid in (Path("/sys/fs/cgroup") / cgroup.lstrip("/") / "cgroup.procs").read_text().split()}
        return any(int(pid) in members and int(pid) not in (os.getpid(), os.getpgrp())
                   and int(parent) not in members and not state.startswith("Z") for pid, parent, _group, state in rows)
    except (OSError, ValueError, subprocess.SubprocessError):
        return True


def metrics(running, path):
    pid = running.process.pid
    if os.name == "nt":
        identity = json.loads((Path(path) / ".spawnpoint-runtime.json").read_bytes())
        pid = identity["pid"]
        import ctypes as c
        from ctypes import wintypes as w
        kernel = c.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        kernel.OpenProcess.restype = w.HANDLE
        kernel.CloseHandle.argtypes = [w.HANDLE]
        kernel.GetProcessTimes.argtypes = [w.HANDLE, *([c.c_void_p] * 4)]
        psapi = c.WinDLL("psapi", use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [w.HANDLE, c.c_void_p, w.DWORD]
        handle = kernel.OpenProcess(0x410, False, pid)
        if not handle:
            raise OSError("runtime metrics unavailable")
        try:
            times = (c.c_ulonglong * 4)()
            if not kernel.GetProcessTimes(handle, *(c.byref(times, i * 8) for i in range(4))):
                raise OSError("runtime CPU unavailable")
            class Memory(c.Structure):
                _fields_ = [("size", w.DWORD), ("faults", w.DWORD), ("peak", c.c_size_t), ("rss", c.c_size_t), ("other", c.c_size_t * 6)]
            memory = Memory()
            memory.size = c.sizeof(memory)
            if not psapi.GetProcessMemoryInfo(handle, c.byref(memory), memory.size):
                raise OSError("runtime RSS unavailable")
            if times[0] != identity["created"]:
                raise OSError("runtime identity changed")
            cpu, rss = (times[2] + times[3]) / 10_000_000, memory.rss
        finally:
            kernel.CloseHandle(handle)
    elif sys.platform == "darwin":
        output = subprocess.check_output(["ps", "-o", "%cpu=,rss=", "-p", str(pid)], timeout=3).decode().split()
        return float(output[0]), int(output[1]) * 1024, pid
    else:
        fields = Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
        cpu = (int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK")
        rss = int(fields[21]) * os.sysconf("SC_PAGE_SIZE")
    now = time.monotonic()
    previous = running.cpu_sample
    running.cpu_sample = (now, cpu)
    percent = max(0, (cpu - previous[1]) / (now - previous[0]) * 100) if previous and now > previous[0] else 0
    return percent, rss, pid


def rpc(body):
    op = body["op"]
    if op == "health":
        return {"ok": True, "pid": os.getpid()}
    id = body.get("id")
    if op == "register":
        value = body["server"]
        id = value["server_id"]
        if str(uuid.UUID(id)) != id or (RECORDS / (id + ".json")).exists():
            raise ValueError("server already registered or invalid id")
        if not Path(value["path"]).is_absolute() or not Path(value["path"]).is_dir():
            raise ValueError("native server needs an existing absolute directory")
        value.update(schema=1, desired=False, attempts=[])
        save(value)
        return True
    value = record(id)
    running = LIVE.get(id)
    if op == "stats":
        # Only the reconciliation loop can declare stopped, after auditing
        # descendants. The Java PID alone is insufficient stopped proof.
        up = bool(running and running.process)
        cpu, rss, pid = 0, 0, None
        if up:
            try:
                cpu, rss, pid = metrics(running, value["path"])
            except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                pass  # Windows guard-to-Java handoff, or exit during sampling
        return dict(running=up, crashed=bool(value.get("blocked")), waiting_start=bool(running and (running.starting or not running.booted or pid is None)),
                    stopping=bool(running and running.stop_at),
                    started=str(value.get("attempt", {}).get("at", "")), cpu=cpu, mem=rss / 1024**2, mem_percent=0,
                    online=0, max=0, players="", version="", desc=value.get("blocked", ""), world_size="",
                    attempt=value.get("attempt"), pid=pid)
    if op == "logs":
        if running:
            return (["Spawnpoint: earlier console output omitted; retained files are in runtime/logs"] if len(running.lines) == 1000 else []) + list(running.lines)
        log = HOME / "logs" / (id + ".log")
        if not log.exists():
            return []
        with log.open("rb") as stream:
            stream.seek(max(0, log.stat().st_size - 256 * 1024))
            return stream.read().decode("utf-8", "replace").splitlines()[-1000:]
    if op == "stdin":
        if not running:
            raise ValueError("server is not running")
        if body.get("attempt") and body["attempt"] != value.get("attempt", {}).get("id"):
            raise ValueError("console attempt changed; command not replayed")
        if body["cmd"].strip().lower() == "stop":
            value["desired"] = False
            save(value)
        running.send(body["cmd"])
    elif op == "action":
        action = body["action"]
        if action == "start_server":
            start(id)
        elif action in ("stop_server", "restart_server", "kill_server"):
            stop(id, action == "restart_server")
            if action == "kill_server" and running and running.process:
                force_stop(running)
        elif action == "accept_eula":
            (Path(value["path"]) / "eula.txt").write_bytes(b"eula=true")
        else:
            raise ValueError("unknown action")
    elif op == "patch":
        fields = body["fields"]
        if set(fields) - {"server_name", "execution_command", "executable", "auto_start", "server_port"}:
            raise ValueError("unsupported native metadata edit")
        if running and set(fields) & {"execution_command", "executable", "server_port"}:
            raise ValueError("stop the server before changing its runtime")
        value.update(fields)
        save(value)
    elif op == "delete":
        if running:
            raise ValueError("stop the server before unregistering it")
        (RECORDS / (id + ".json")).unlink()
    else:
        raise ValueError("unknown operation")
    return True


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # never log the IPC capability or console commands

    def do_POST(self):
        status, answer = 200, None
        try:
            self.connection.settimeout(5)
            if self.path != "/rpc" or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN):
                self.send_error(403)
                return
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 64 * 1024:
                raise ValueError("invalid IPC body size")
            body = json.loads(self.rfile.read(length))
            with LOCK:
                answer = {"result": rpc(body)}
        except Exception as error:
            status, answer = 409, {"error": str(error)}
        payload = json.dumps(answer).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def contain_windows():
    if os.name != "nt":
        return None
    import ctypes as c
    from ctypes import wintypes as w
    # A service-level Job covers the owner, helper and guards. The existing
    # guard additionally owns each Java subtree in its own nested Job.
    class Limits(c.Structure):
        _fields_ = [("time", c.c_longlong * 2), ("flags", w.DWORD), ("min", c.c_size_t), ("max", c.c_size_t), ("count", w.DWORD), ("affinity", c.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]
    class Extended(c.Structure):
        _fields_ = [("basic", Limits), ("io", c.c_ulonglong * 6), ("memory", c.c_size_t * 4)]
    kernel = c.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    kernel.GetCurrentProcess.restype = w.HANDLE
    handle = kernel.CreateJobObjectW(None, None)
    limits = Extended()
    limits.basic.flags = 0x2000
    if not handle or not kernel.SetInformationJobObject(handle, 9, c.byref(limits), c.sizeof(limits)) or not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        raise c.WinError(c.get_last_error())
    return handle


def main():
    os.umask(0o077)
    HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    owner = HOME / "owner"
    owner.mkdir(exist_ok=True)
    fence = launchguard.lock_runtime(owner)
    job = contain_windows()
    RECORDS.mkdir(exist_ok=True)
    for path in RECORDS.glob("*.json"):
        value = record(path.stem)
        if value.get("auto_start"):
            value["desired"] = True
            save(value)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    atomic(HOME / "endpoint.json", {"port": server.server_port, "token": TOKEN})
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM, lambda *_: EXIT.set())
        signal.signal(signal.SIGINT, lambda *_: EXIT.set())
    print("Spawnpoint supervisor ready", flush=True)
    while not EXIT.wait(0.25):
        with LOCK:
            for id, running in list(LIVE.items()):
                if running.process and running.process.poll() is not None:
                    if os.name != "nt" and orphaned_children():
                        os._exit(75)
                    value = record(id)
                    if value["desired"] and not running.booted:
                        value["blocked"] = "launch guard refused or runtime failed before its verified start"
                    value["retryAt"] = time.time() + 10
                    save(value)
                    LIVE.pop(id)
                elif running.stop_at and time.monotonic() > running.stop_at and running.process:
                    force_stop(running)
            for path in RECORDS.glob("*.json"):
                value = record(path.stem)
                if value["desired"] and not value.get("blocked") and path.stem not in LIVE and time.time() >= value.get("retryAt", 0):
                    start(path.stem, True)
            # Serialize opaque loader installers and their JDK downloads.
            # Shared mod metadata is configured only by the panel afterward.
            for id, child in list(INSTALLING.items()):
                if child.poll() is not None:
                    state = json.loads((HOME / "installs" / (id + ".json")).read_bytes())
                    if child.returncode != 0 or state["phase"] in ("queued", "installing"):
                        # A dead helper does not prove its Java children died.
                        # OS service containment must reap them before retry.
                        os._exit(75)
                    INSTALLING.pop(id)
                elif time.monotonic() > child.install_deadline:
                    path = HOME / "installs" / (id + ".json")
                    failed = json.loads(path.read_bytes())
                    failed.update(phase="failed", status="failed", done=True, error="installer exceeded fifteen minutes; owner service restarted to contain its whole process tree")
                    atomic(path, failed)
                    os._exit(75)
            if not INSTALLING:
                for path in (HOME / "installs").glob("*.json"):
                    if len(path.stem) != 36:
                        continue
                    install_job = json.loads(path.read_bytes())
                    if install_job["phase"] not in ("queued", "installing"):
                        continue
                    INSTALLING[path.stem] = subprocess.Popen([NODE, str(Path(__file__).with_name("nativeinstall.js")), path.stem],
                                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    INSTALLING[path.stem].install_deadline = time.monotonic() + 900
                    break
    with LOCK:
        for running in LIVE.values():
            if running.process and running.process.poll() is None:
                try:
                    running.send("stop")
                except Exception:
                    pass
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline and any(r.process and r.process.poll() is None for r in LIVE.values()):
        time.sleep(0.25)
    server.shutdown()
    # Service containment kills any remaining trees. Retain desired state for
    # the next service boot; shutdown is not an owner-requested server stop.
    # Keep the lifetime fence/Job open until process exit. In a Windows SCM
    # callback, returning allows the wrapper to acknowledge SERVICE_STOPPED.
    return fence, job


if __name__ == "__main__":
    if sys.argv[1:2] == ["--run"]:
        run_java(sys.argv[2])
    else:
        lifetime = main()
