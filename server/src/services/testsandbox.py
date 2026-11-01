"""Run one candidate test process in a Windows AppContainer.

The container has no network capabilities: no network except loopback among
processes of the same container. It reads only runtimes granted to the
container SID and writes only its scratch, which is granted to a capability
SID that this process alone carries, so two processes sharing the container
(the join's server copy and client) cannot write each other's files. A
kill-on-close Job Object caps memory and CPU, so the test dies with this
helper. Standard handles pass straight through.
"""
import argparse
from contextlib import contextmanager
import ctypes as c
from ctypes import wintypes as w
import json
import os
import stat
import subprocess
import sys
import threading
import time


@contextmanager
def open_output(root, relative):
    """Walk through pinned directory handles, never a check-then-open path.

    On Unix openat/O_NOFOLLOW pins each component. On Windows opened
    components refuse reparse points and deny delete-sharing until the final
    read completes, so a writer cannot replace an intermediate directory.
    """
    parts = relative.replace("\\", "/").split("/")
    if not parts or any(p in ("", ".", "..") or ":" in p for p in parts):
        raise ValueError("invalid relative output path")
    held = []
    try:
        if os.name != "nt":
            held.append(os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
            for i, part in enumerate(parts):
                held.append(os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                                    | (os.O_DIRECTORY if i < len(parts) - 1 else 0), dir_fd=held[-1]))
            fd = held[-1]
        else:
            import msvcrt
            kernel = c.WinDLL("kernel32", use_last_error=True)
            kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
            kernel.CreateFileW.restype = w.HANDLE
            kernel.GetFileInformationByHandle.argtypes = [w.HANDLE, c.c_void_p]
            kernel.CloseHandle.argtypes = [w.HANDLE]
            class INFO(c.Structure):
                _fields_ = [("attrs", w.DWORD), ("created", w.FILETIME), ("accessed", w.FILETIME),
                            ("written", w.FILETIME), ("volume", w.DWORD), ("high", w.DWORD),
                            ("low", w.DWORD), ("links", w.DWORD), ("index_high", w.DWORD), ("index_low", w.DWORD)]
            path = os.path.abspath(root)
            for part in [None, *parts]:
                if part is not None:
                    path = os.path.join(path, part)
                handle = kernel.CreateFileW(path, 0x80000000, 3, None, 3, 0x02200000, None)
                if handle == w.HANDLE(-1).value:
                    raise c.WinError(c.get_last_error())
                info = INFO()
                if not kernel.GetFileInformationByHandle(handle, c.byref(info)) or info.attrs & 0x400:
                    kernel.CloseHandle(handle)
                    raise ValueError("output contains a reparse point")
                held.append(msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY))
            fd = held[-1]
        yield fd, os.path.join(root, *parts)
    finally:
        for fd in reversed(held):
            os.close(fd)


def read_output(root, relative):
    with open_output(root, relative) as (fd, _path):
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 256 * 1024 * 1024:
            raise ValueError("output must be a bounded regular file without hard links")
        remaining = 256 * 1024 * 1024
        while remaining:
            chunk = os.read(fd, min(remaining, 1024 * 1024))
            if not chunk:
                return
            sys.stdout.buffer.write(chunk)
            remaining -= len(chunk)
        if os.read(fd, 1):
            raise ValueError("output grew beyond the limit")


def list_output(root, relative):
    files = []
    def visit(rel):
        with open_output(root, rel) as (fd, path):
            info = os.fstat(fd)
            if stat.S_ISDIR(info.st_mode):
                # Windows ancestors remain open without delete sharing while
                # this path is enumerated. Unix lists the pinned fd itself.
                for name in sorted(os.listdir(path if os.name == "nt" else fd)):
                    visit(rel + "/" + name)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                files.append(rel)
                if len(files) > 20000:
                    raise ValueError("too many output files")
            else:
                raise ValueError("output is not a regular file")
    try:
        visit(relative)
    except FileNotFoundError:
        # An absent optional output directory has no files.
        if files:
            raise
    print(json.dumps(files))


if sys.argv[1:2] in (["--read-output"], ["--list-output"]):
    (read_output if sys.argv[1] == "--read-output" else list_output)(*sys.argv[2:])
    sys.exit(0)

k32 = c.WinDLL("kernel32", use_last_error=True)
userenv = c.WinDLL("userenv", use_last_error=True)
advapi = c.WinDLL("advapi32", use_last_error=True)

userenv.CreateAppContainerProfile.argtypes = [w.LPCWSTR, w.LPCWSTR, w.LPCWSTR, c.c_void_p, w.DWORD, c.POINTER(c.c_void_p)]
userenv.CreateAppContainerProfile.restype = c.c_long
userenv.DeriveAppContainerSidFromAppContainerName.argtypes = [w.LPCWSTR, c.POINTER(c.c_void_p)]
userenv.DeriveAppContainerSidFromAppContainerName.restype = c.c_long
advapi.ConvertSidToStringSidW.argtypes = [c.c_void_p, c.POINTER(w.LPWSTR)]
kbase = c.WinDLL("kernelbase", use_last_error=True)
kbase.DeriveCapabilitySidsFromName.argtypes = [w.LPCWSTR, c.POINTER(c.POINTER(c.c_void_p)), c.POINTER(w.DWORD), c.POINTER(c.POINTER(c.c_void_p)), c.POINTER(w.DWORD)]
k32.CreateJobObjectW.restype = w.HANDLE
k32.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
k32.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
k32.InitializeProcThreadAttributeList.argtypes = [c.c_void_p, w.DWORD, w.DWORD, c.POINTER(c.c_size_t)]
k32.UpdateProcThreadAttribute.argtypes = [c.c_void_p, w.DWORD, c.c_size_t, c.c_void_p, c.c_size_t, c.c_void_p, c.c_void_p]
k32.GetStdHandle.restype = w.HANDLE
k32.SetHandleInformation.argtypes = [w.HANDLE, w.DWORD, w.DWORD]
k32.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
k32.ResumeThread.argtypes = [w.HANDLE]
k32.ResumeThread.restype = w.DWORD
k32.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
k32.WaitForSingleObject.restype = w.DWORD
k32.GetExitCodeProcess.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
k32.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
k32.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
k32.QueryInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p]
k32.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k32.OpenProcess.restype = w.HANDLE
k32.CloseHandle.argtypes = [w.HANDLE]


def check(ok):
    if not ok:
        raise c.WinError(c.get_last_error())
    return ok


def container(name):
    sid = c.c_void_p()
    # A fresh lowbox identity per test, with no persistent profile/cache and
    # no loopback exemptions. Related processes use the same package SID.
    hr = userenv.DeriveAppContainerSidFromAppContainerName(name, c.byref(sid))
    if hr:
        raise OSError("AppContainer profile failed (0x%08x)" % (hr & 0xFFFFFFFF))
    return sid, sid_text(sid)


def sid_text(sid):
    text = w.LPWSTR()
    check(advapi.ConvertSidToStringSidW(sid, c.byref(text)))
    return text.value


def capability(name):
    groups, ngroups, caps, ncaps = c.POINTER(c.c_void_p)(), w.DWORD(), c.POINTER(c.c_void_p)(), w.DWORD()
    check(kbase.DeriveCapabilitySidsFromName(name, c.byref(groups), c.byref(ngroups), c.byref(caps), c.byref(ncaps)))
    if not ncaps.value:
        raise OSError("no capability SID for " + name)
    return caps[0]


def grant(path, sid, rights):
    """Inheritable grant for the container SID. icacls output names the SID
    once granted, so large runtime trees are only walked the first time."""
    ace = "*" + sid + ":(OI)(CI)" + rights
    shown = subprocess.run(["icacls", path], capture_output=True, text=True).stdout
    if sid in shown and ("(" + rights + ")") in shown.split(sid, 1)[1].splitlines()[0]:
        return
    subprocess.run(["icacls", path, "/grant", ace, "/C", "/Q"], check=True, stdout=subprocess.DEVNULL)


class BASIC(c.Structure):
    _fields_ = [("PerProcessUserTimeLimit", c.c_int64), ("PerJobUserTimeLimit", c.c_int64), ("LimitFlags", w.DWORD),
                ("MinimumWorkingSetSize", c.c_size_t), ("MaximumWorkingSetSize", c.c_size_t), ("ActiveProcessLimit", w.DWORD),
                ("Affinity", c.c_size_t), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]


class IO(c.Structure):
    _fields_ = [(n, c.c_uint64) for n in ("r", "w", "o", "rb", "wb", "ob")]


class EXTENDED(c.Structure):
    _fields_ = [("Basic", BASIC), ("Io", IO), ("ProcessMemoryLimit", c.c_size_t), ("JobMemoryLimit", c.c_size_t),
                ("PeakProcessMemoryUsed", c.c_size_t), ("PeakJobMemoryUsed", c.c_size_t)]


class CPURATE(c.Structure):
    _fields_ = [("ControlFlags", w.DWORD), ("CpuRate", w.DWORD)]


class ACCOUNTING(c.Structure):
    _fields_ = [(n, c.c_int64) for n in ("user", "kernel", "period_user", "period_kernel")] + [
        (n, w.DWORD) for n in ("faults", "total", "active", "terminated")]


class SIDATTR(c.Structure):
    _fields_ = [("Sid", c.c_void_p), ("Attributes", w.DWORD)]


class CAPS(c.Structure):
    _fields_ = [("AppContainerSid", c.c_void_p), ("Capabilities", c.c_void_p), ("CapabilityCount", w.DWORD), ("Reserved", w.DWORD)]


class STARTUPINFO(c.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR),
                ("dwX", w.DWORD), ("dwY", w.DWORD), ("dwXSize", w.DWORD), ("dwYSize", w.DWORD),
                ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD), ("dwFlags", w.DWORD),
                ("wShowWindow", w.WORD), ("cbReserved2", w.WORD), ("lpReserved2", c.c_void_p),
                ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]


class STARTUPINFOEX(c.Structure):
    _fields_ = [("StartupInfo", STARTUPINFO), ("lpAttributeList", c.c_void_p)]


class PROCINFO(c.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE), ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--mem-mb", type=int, required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--capability", required=True)
    parser.add_argument("--control")
    parser.add_argument("--write", action="append", default=[])
    parser.add_argument("--read", action="append", default=[])
    parser.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
    sid, _package = container(args.name)
    own = capability(args.capability)
    runtime = capability("spawnpointRuntimeRead")
    for path in args.read:
        grant(path, sid_text(runtime), "RX")
    for path in args.write:
        grant(path, sid_text(own), "M")

    job = check(k32.CreateJobObjectW(None, None))
    limits = EXTENDED()
    # kill on close | job memory | priority class | active process limit
    limits.Basic.LimitFlags = 0x2000 | 0x200 | 0x20 | 0x8
    limits.Basic.ActiveProcessLimit = 64
    limits.Basic.PriorityClass = 0x4000  # below normal
    limits.JobMemoryLimit = args.mem_mb * 1024 * 1024
    check(k32.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits)))
    rate = CPURATE(0x1 | 0x4, max(1, (os.cpu_count() or 2) // 2) * 10000 // (os.cpu_count() or 2))
    check(k32.SetInformationJobObject(job, 15, c.byref(rate), c.sizeof(rate)))

    held = (SIDATTR * 2)(SIDATTR(own, 0x4), SIDATTR(runtime, 0x4))  # SE_GROUP_ENABLED
    caps = CAPS(sid, c.cast(held, c.c_void_p), 2, 0)
    size = c.c_size_t()
    k32.InitializeProcThreadAttributeList(None, 2, 0, c.byref(size))
    attrs = (c.c_byte * size.value)()
    check(k32.InitializeProcThreadAttributeList(attrs, 2, 0, c.byref(size)))
    check(k32.UpdateProcThreadAttribute(attrs, 0, 0x20009, c.byref(caps), c.sizeof(caps), None, None))
    # LPAC: ignore ambient ALL APPLICATION PACKAGES grants. Only explicit
    # capabilities and OS ALL RESTRICTED APPLICATION PACKAGES grants apply.
    opt_out = w.DWORD(1)
    check(k32.UpdateProcThreadAttribute(attrs, 0, 0x2000F, c.byref(opt_out), c.sizeof(opt_out), None, None))
    info = STARTUPINFOEX()
    info.StartupInfo.cb = c.sizeof(info)
    info.StartupInfo.dwFlags = 0x100  # use std handles
    handles = [k32.GetStdHandle(n) for n in (-10, -11, -12)]
    for h in handles:
        if h and h != w.HANDLE(-1).value:
            check(k32.SetHandleInformation(h, 1, 1))
    info.StartupInfo.hStdInput, info.StartupInfo.hStdOutput, info.StartupInfo.hStdError = handles
    info.lpAttributeList = c.cast(attrs, c.c_void_p)
    child_env = dict(os.environ)
    child_env["PATH"] = os.path.join(os.environ["SystemRoot"], "System32")
    env = "".join(k + "=" + v + "\0" for k, v in sorted(child_env.items())) + "\0"
    proc = PROCINFO()
    command = c.create_unicode_buffer(subprocess.list2cmdline(argv))
    # extended startup info | suspended | unicode environment
    k32.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD,
                                 c.c_void_p, w.LPCWSTR, c.POINTER(STARTUPINFOEX), c.POINTER(PROCINFO)]
    code = w.DWORD(1)
    parent = check(k32.OpenProcess(0x100000, False, os.getppid()))  # SYNCHRONIZE only
    finished = threading.Event()
    def cancellation():
        while not finished.wait(0.05):
            if k32.WaitForSingleObject(parent, 0) != 0x102 or (args.control and os.path.exists(os.path.join(args.control, "cancel"))):
                k32.TerminateJobObject(job, 1)
                return
    watcher = threading.Thread(target=cancellation, daemon=True)
    try:
        check(k32.CreateProcessW(None, command, None, None, True, 0x80000 | 0x4 | 0x400, c.create_unicode_buffer(env), args.cwd,
                                 c.byref(info), c.byref(proc)))
        check(k32.AssignProcessToJobObject(job, proc.hProcess))
        if k32.ResumeThread(proc.hThread) == 0xFFFFFFFF:
            raise c.WinError(c.get_last_error())
        watcher.start()
        if k32.WaitForSingleObject(proc.hProcess, 0xFFFFFFFF) != 0:
            raise c.WinError(c.get_last_error())
        check(k32.GetExitCodeProcess(proc.hProcess, c.byref(code)))
    finally:
        finished.set()
        if watcher.ident is not None:
            watcher.join()
        if proc.hProcess:
            k32.TerminateProcess(proc.hProcess, 1)
        check(k32.TerminateJobObject(job, 1))
        accounting = ACCOUNTING()
        # Termination is asynchronous. Retain the Job until all descendants
        # are gone, before the panel consumes outputs or removes scratch.
        while True:
            check(k32.QueryInformationJobObject(job, 1, c.byref(accounting), c.sizeof(accounting), None))
            if not accounting.active:
                break
            time.sleep(0.01)
        k32.CloseHandle(job)
        k32.CloseHandle(parent)
        if proc.hThread:
            k32.CloseHandle(proc.hThread)
        if proc.hProcess:
            k32.CloseHandle(proc.hProcess)
        if args.control:
            # This directory is never granted to the lowbox. A killed helper
            # cannot falsely acknowledge that output capture is now safe.
            with open(os.path.join(args.control, "closed"), "x"):
                pass
    sys.exit(code.value)


if __name__ == "__main__":
    main()
