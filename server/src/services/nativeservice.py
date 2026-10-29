"""Install the independent owner with native OS process containment.

No panel process starts or adopts the owner. Unix defaults to a user service;
Windows uses a dedicated virtual service account, not LocalSystem.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request

NAME = "SpawnpointSupervisor"
LABEL = "com.spawnpoint.supervisor"


def run(*args):
    subprocess.run(args, check=True)


def windows_service(root, node):
    import ctypes as c
    from ctypes import wintypes as w
    os.environ["SPAWNPOINT_ROOT"] = str(root)
    os.environ["SPAWNPOINT_NODE"] = str(node)
    import supervisor
    log = root / "Spawnpoint/data/runtime/service.log"
    sys.stdout = sys.stderr = log.open("a", encoding="utf-8", buffering=1)
    class Status(c.Structure):
        _fields_ = [(key, w.DWORD) for key in ("type", "state", "accepted", "exit", "specific", "checkpoint", "wait")]
    main_type = c.WINFUNCTYPE(None, w.DWORD, c.POINTER(w.LPWSTR))
    control_type = c.WINFUNCTYPE(None, w.DWORD)
    class Entry(c.Structure):
        _fields_ = [("name", w.LPWSTR), ("main", main_type)]
    api = c.WinDLL("advapi32", use_last_error=True)
    api.RegisterServiceCtrlHandlerW.argtypes = [w.LPCWSTR, control_type]
    api.RegisterServiceCtrlHandlerW.restype = w.HANDLE
    api.SetServiceStatus.argtypes = [w.HANDLE, c.POINTER(Status)]
    api.StartServiceCtrlDispatcherW.argtypes = [c.POINTER(Entry)]
    handle = None
    lifetime = []
    def status(state, error=0):
        value = Status(0x10, state, 0x5 if state == 4 else 0, error, 0, 0, 60_000 if state == 3 else 0)
        if not api.SetServiceStatus(handle, c.byref(value)):
            raise c.WinError(c.get_last_error())
    @control_type
    def control(code):
        if code in (1, 5):
            status(3)
            supervisor.EXIT.set()
    @main_type
    def main(_argc, _argv):
        nonlocal handle
        handle = api.RegisterServiceCtrlHandlerW(NAME, control)
        if not handle:
            return
        try:
            status(4)
            lifetime.extend(supervisor.main())
            status(1)
        except BaseException:
            import traceback
            traceback.print_exc()
            status(1, 1)
    table = (Entry * 2)(Entry(NAME, main), Entry(None, main_type()))
    if not api.StartServiceCtrlDispatcherW(table):
        raise c.WinError(c.get_last_error())


def install(root, node, system, user):
    script = Path(__file__).resolve()
    owner = script.with_name("supervisor.py")
    runtime = root / "Spawnpoint/data/runtime"
    account = None
    missing = []
    if sys.platform == "linux" and system:
        import pwd
        if not user:
            raise ValueError("a system service requires --user with an unprivileged account")
        account = pwd.getpwnam(user)
        if account.pw_uid == 0:
            raise ValueError("Java must not run as root")
        path = runtime
        while not path.exists():
            missing.append(path)
            path = path.parent
        if root.exists() and root.stat().st_uid != account.pw_uid:
            raise ValueError("the layout must belong to the selected unprivileged service user")
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    if account:
        for path in missing:
            os.chown(path, account.pw_uid, account.pw_gid)
        if runtime.stat().st_uid != account.pw_uid:
            raise ValueError("existing private runtime belongs to another user; correct ownership before installation")
    if sys.platform == "win32":
        if system or user:
            raise ValueError("Windows uses its dedicated virtual service account")
        # list2cmdline encodes the SCM command without a shell/interpolation.
        command = subprocess.list2cmdline([sys.executable, str(script), "run", "--root", str(root), "--node", str(node)])
        existing = subprocess.run(["sc.exe", "query", NAME], capture_output=True).returncode == 0
        if existing:
            raise ValueError("service already exists; stop it and use sc.exe config to update its pinned executable paths")
        run("sc.exe", "create", NAME, "binPath=", command, "start=", "auto", "obj=", "NT SERVICE\\" + NAME)
        run("sc.exe", "sidtype", NAME, "unrestricted")
        # Resolve the installing user's SID without passwords or credential files.
        sid = subprocess.check_output(["powershell", "-NoProfile", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], text=True).strip()
        principals = ["*" + sid + ":(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "NT SERVICE\\" + NAME + ":(OI)(CI)M"]
        run("icacls", str(root), "/grant:r", *principals)
        data = root / "Spawnpoint/data"
        run("icacls", str(data), "/inheritance:r", "/grant:r", *principals, "/T", "/Q")
        run("icacls", str(data), "/remove:g", "*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545", "/T", "/Q")
        run("sc.exe", "failure", NAME, "reset=", "86400", "actions=", "restart/5000/restart/10000/restart/30000")
        run("sc.exe", "failureflag", NAME, "1")
        run("sc.exe", "start", NAME)
    elif sys.platform == "darwin":
        if system or user:
            raise ValueError("macOS installs a LaunchAgent for the current user")
        target = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
        target.parent.mkdir(parents=True, exist_ok=True)
        config = {"Label": LABEL, "ProgramArguments": [sys.executable, str(owner)], "RunAtLoad": True,
                  "KeepAlive": True, "ThrottleInterval": 10, "AbandonProcessGroup": False, "ExitTimeOut": 60,
                  "EnvironmentVariables": {"SPAWNPOINT_ROOT": str(root), "SPAWNPOINT_NODE": str(node)},
                  "StandardOutPath": str(runtime / "service.log"), "StandardErrorPath": str(runtime / "service.log")}
        target.write_bytes(plistlib.dumps(config))
        domain = "gui/" + str(os.getuid())
        subprocess.run(["launchctl", "bootout", domain + "/" + LABEL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run("launchctl", "bootstrap", domain, str(target))
    elif sys.platform == "linux":
        if system and not user:
            raise ValueError("a system service requires --user with an unprivileged account")
        if user == "root" or (not system and os.geteuid() == 0):
            raise ValueError("Java must not run as root")
        target = Path("/etc/systemd/system/spawnpoint-supervisor.service") if system else Path.home() / ".config/systemd/user/spawnpoint-supervisor.service"
        target.parent.mkdir(parents=True, exist_ok=True)
        quote = lambda value: json.dumps(str(value)).replace("%", "%%")
        target.write_text("[Unit]\nDescription=Spawnpoint independent Java owner\nAfter=network-online.target\n\n[Service]\nType=simple\n"
                          + ("User=" + user + "\n" if system else "")
                          + "Environment=" + quote("SPAWNPOINT_ROOT=" + str(root)) + "\nEnvironment=" + quote("SPAWNPOINT_NODE=" + str(node))
                          + "\nExecStart=" + quote(sys.executable) + " " + quote(owner)
                          + "\nRestart=always\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=60\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy="
                          + ("multi-user.target\n" if system else "default.target\n"), encoding="utf-8")
        command = ["systemctl"] + ([] if system else ["--user"])
        run(*command, "daemon-reload")
        run(*command, "enable", "--now", "spawnpoint-supervisor.service")
        if not system:
            print("For startup before login, enable lingering for " + getpass.getuser() + " (loginctl enable-linger).")
    else:
        raise ValueError("supported service hosts are Linux, macOS and Windows")
    # A successful service-manager request is not proof that this owner bound
    # its IPC endpoint. Reject another service's stale endpoint as well.
    for _ in range(30):
        try:
            if sys.platform == "linux":
                pid = int(subprocess.check_output([*command, "show", "--property=MainPID", "--value", "spawnpoint-supervisor.service"], text=True))
            elif sys.platform == "darwin":
                info = subprocess.check_output(["launchctl", "print", domain + "/" + LABEL], text=True)
                pid = int(re.search(r"\bpid = (\d+)", info)[1])
            else:
                info = subprocess.check_output(["sc.exe", "queryex", NAME], text=True)
                pid = int(re.search(r"\bPID\s*:\s*(\d+)", info)[1])
            endpoint = json.loads((runtime / "endpoint.json").read_bytes())
            request = urllib.request.Request("http://127.0.0.1:" + str(endpoint["port"]) + "/rpc",
                                             data=b'{"op":"health"}', headers={"Authorization": "Bearer " + endpoint["token"], "Content-Type": "application/json"})
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=1) as response:
                if pid > 0 and json.load(response)["result"]["pid"] == pid:
                    print("Spawnpoint supervisor service is ready")
                    return
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            pass
        time.sleep(1)
    raise RuntimeError("installed service did not become ready; inspect its service log before starting the panel")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "run"])
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--node", type=Path, default=Path(shutil.which("node") or "node"))
    parser.add_argument("--system", action="store_true")
    parser.add_argument("--user")
    args = parser.parse_args()
    if args.action == "run":
        if os.name != "nt":
            raise ValueError("run is the Windows SCM entrypoint; Unix services invoke supervisor.py")
        windows_service(args.root.resolve(), args.node.resolve())
    else:
        install(args.root.resolve(), args.node.resolve(), args.system, args.user)
