"""Crafty's required pre-JVM gate. Python's stdlib is already required by Crafty.

The publication mutex is shared with the panel through the server directory.
A panel crash holding it deliberately blocks a direct Crafty start until the
panel recovers it; it must never fall back to launching without verification.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys


def windows_creation(process):
    import ctypes as c
    from ctypes import wintypes as w
    kernel = c.WinDLL("kernel32", use_last_error=True)
    kernel.GetProcessTimes.argtypes = [w.HANDLE, *([c.c_void_p] * 4)]
    times = (c.c_ulonglong * 4)()
    if not kernel.GetProcessTimes(process, *(c.byref(times, i * 8) for i in range(4))):
        raise c.WinError(c.get_last_error())
    return times[0]


def lock_runtime(root, relocating=False):
    # File locks are shared across the bind mount and released by the kernel
    # even after SIGKILL. Never unlink this inode while anyone may hold it.
    if os.name == "nt":
        import _winapi
        import msvcrt
        # Share mode zero excludes other opens for as long as either Java
        # or this guard holds the inherited handle. The identity barrier
        # below also covers handle rundown before exit is signaled.
        # A stopped transfer may rename the enclosing directory, never the
        # fence inode. Share-delete still excludes every read/write opener.
        handle = _winapi.CreateFile(str(root / ".spawnpoint-runtime.lock"), 0xC0000000, 4 if relocating else 0, 0, 4, 0x80, 0)
        stream = os.fdopen(msvcrt.open_osfhandle(handle, os.O_RDWR), "a+b")
        os.set_inheritable(stream.fileno(), True)
        try:
            # Windows closes inherited handles before signaling process exit.
            # Bridge that rundown interval with the exact persisted identity;
            # PID reuse must not fence an unrelated later process.
            record = root / ".spawnpoint-runtime.json"
            try:
                raw = record.read_bytes()
            except FileNotFoundError:
                raw = None
            if raw is not None:
                identity = json.loads(raw)
                if (not isinstance(identity, dict) or set(identity) != {"pid", "created"}
                        or any(type(identity[k]) is not int for k in identity)
                        or not 0 < identity["pid"] < 2**32 or not 0 < identity["created"] < 2**64):
                    raise ValueError("interrupted runtime creation needs owner recovery")
                try:
                    process = _winapi.OpenProcess(0x101000, False, identity["pid"])
                except OSError as error:
                    if error.winerror != 87:  # only a confirmed absent PID
                        raise
                else:
                    try:
                        if windows_creation(process) == identity["created"] and _winapi.WaitForSingleObject(process, 0) != 0:
                            raise BlockingIOError("the previous runtime has not finished exiting")
                    finally:
                        _winapi.CloseHandle(process)
                record.unlink()
            return stream
        except BaseException:
            stream.close()
            raise
    import fcntl
    stream = (root / ".spawnpoint-runtime.lock").open("a+b")
    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return stream


def digest(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"not a regular locked file: {path}")
    h = hashlib.sha512()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def windows_runtime(args, root):
    # The Job handle is deliberately non-inheritable. If Crafty or Windows
    # kills this guard, closing that handle kills Java before its fence can
    # be reused. Start suspended so Java cannot run before assignment.
    import ctypes as c
    from ctypes import wintypes as w
    import _winapi

    class Limits(c.Structure):
        _fields_ = [("process_time", c.c_longlong), ("job_time", c.c_longlong),
                    ("flags", w.DWORD), ("min_working", c.c_size_t),
                    ("max_working", c.c_size_t), ("processes", w.DWORD),
                    ("affinity", c.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]

    class Extended(c.Structure):
        _fields_ = [("basic", Limits), ("io", c.c_ulonglong * 6),
                    ("process_memory", c.c_size_t), ("job_memory", c.c_size_t),
                    ("peak_process", c.c_size_t), ("peak_job", c.c_size_t)]

    kernel = c.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    kernel.ResumeThread.argtypes = [w.HANDLE]
    kernel.ResumeThread.restype = w.DWORD
    kernel.CloseHandle.argtypes = [w.HANDLE]
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise c.WinError(c.get_last_error())
    process = thread = None
    record = root / ".spawnpoint-runtime.json"
    try:
        limits = Extended()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits)):
            raise c.WinError(c.get_last_error())
        startup = subprocess.STARTUPINFO()
        startup.dwFlags = subprocess.STARTF_USESTDHANDLES
        startup.hStdInput = _winapi.GetStdHandle(-10)
        startup.hStdOutput = _winapi.GetStdHandle(-11)
        startup.hStdError = _winapi.GetStdHandle(-12)
        record.write_bytes(b'{"starting":true}')
        process, thread, pid, _ = _winapi.CreateProcess(args[0], subprocess.list2cmdline(args), None, None, True, 4, None, None, startup)
        part = record.with_suffix(".json.part")
        part.write_bytes(json.dumps({"pid": pid, "created": windows_creation(process)}).encode("ascii"))
        part.replace(record)
        if not kernel.AssignProcessToJobObject(job, process):
            raise c.WinError(c.get_last_error())
        if kernel.ResumeThread(thread) == 0xFFFFFFFF:
            raise c.WinError(c.get_last_error())
        _winapi.WaitForSingleObject(process, _winapi.INFINITE)
        return _winapi.GetExitCodeProcess(process)
    finally:
        if process is not None:
            # Also handles failure before assignment, while still suspended.
            if _winapi.WaitForSingleObject(process, 0) != 0:
                try:
                    _winapi.TerminateProcess(process, 1)
                except PermissionError:
                    # Windows denies termination if the process just exited.
                    if _winapi.WaitForSingleObject(process, 0) != 0:
                        raise
            _winapi.WaitForSingleObject(process, _winapi.INFINITE)
            _winapi.CloseHandle(thread)
            _winapi.CloseHandle(process)
        record.unlink(missing_ok=True)
        kernel.CloseHandle(job)


def main():
    relocating = len(sys.argv) == 3 and sys.argv[1] == "--fence"
    root = Path(sys.argv[2]).resolve() if relocating else Path.cwd()
    runtime = lock_runtime(root, relocating)
    if relocating or sys.argv[1:] == ["--fence"]:
        print("locked", flush=True)
        sys.stdin.buffer.read()
        return
    if (root / ".spawnpoint-mutation").exists():
        raise ValueError("interrupted revision mutation needs journal recovery")
    gate = json.loads((root / ".spawnpoint-revision.json").read_bytes())
    mutex = root / ".spawnpoint-publication"
    # mkdir is atomic across the container/host bind mount. Never guess that
    # another namespace's PID is dead or steal a publication lock on timeout.
    mutex.mkdir()
    try:
        if sys.argv[1:] != shlex.split(gate["command"])[2:]:
            raise ValueError("launch arguments differ from the locked command")
        if gate.get("hosting"):
            config = root / "automodpack/automodpack-server.json"
            paused = gate["hosting"]["paused"]
            current = config.read_bytes().decode("utf-8")
            if current not in (paused, gate["hosting"]["original"]):
                raise ValueError("AutoModpack configuration changed outside the revision")
            part = config.with_suffix(".json.guard-part")
            part.write_bytes(paused.encode("utf-8"))
            part.replace(config)
        for file in gate["files"]:
            relative = Path(file["path"])
            path = root / relative
            if relative.is_absolute() or ".." in relative.parts or any(p.is_symlink() for p in [path, *path.parents] if p != root):
                raise ValueError("invalid locked path")
            if digest(path) != file["sha512"] or path.stat().st_size != file["size"]:
                raise ValueError(f"revision {gate['revision']}: different bytes for {file['path']}")
        listed = {f["path"] for f in gate["files"]}
        for directory in gate["roots"]:
            for path in (root / directory).rglob("*"):
                if path.is_symlink():
                    raise ValueError(f"unlisted symlink: {path}")
                if path.is_file() and path.relative_to(root).as_posix() not in listed:
                    raise ValueError(f"unlisted pack file: {path.relative_to(root)}")
        java = Path(sys.argv[1])
        if java != Path(gate["java"]["executable"]) or digest(java) != gate["java"]["sha512"]:
            raise ValueError("Java differs from the locked runtime")
        for file in gate["java"]["files"]:
            if digest(Path(file["path"])) != file["sha512"]:
                raise ValueError(f"Java runtime file changed: {file['path']}")
    finally:
        mutex.rmdir()
    print(f"Spawnpoint: revision {gate['revision']} verified; pack hosting held", flush=True)
    # Retain the runtime lock until Java exits, including the handoff between
    # verification and spawn. Inherit stdin so Crafty's console still works.
    if os.name != "nt":
        os.set_inheritable(runtime.fileno(), True)
        os.execv(str(java), sys.argv[1:])
    code = windows_runtime(sys.argv[1:], root)
    runtime.close()
    sys.exit(code)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Spawnpoint refused to launch: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
