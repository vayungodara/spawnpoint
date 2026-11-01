"""Temporary CI diagnostic using only the native permission-check fixture."""
import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile
import uuid

source = Path("server/dist/services/testsandbox.py").resolve()
spec = importlib.util.spec_from_file_location("sandbox", source)
box = importlib.util.module_from_spec(spec)
spec.loader.exec_module(box)
security = box.advapi.SetSecurityInfo
attribute = box.k32.UpdateProcThreadAttribute
class Trustee(box.c.Structure):
    _fields_ = [("multiple", box.c.c_void_p), ("operation", box.w.DWORD), ("form", box.w.DWORD),
                ("kind", box.w.DWORD), ("sid", box.c.c_void_p)]
class Access(box.c.Structure):
    _fields_ = [("mask", box.w.DWORD), ("mode", box.w.DWORD), ("inheritance", box.w.DWORD), ("trustee", Trustee)]

for variant in ("protected-lpac", "default-registry-lpac", "protected-appcontainer", "tcp-device-lpac"):
    name = "Spawnpoint.Diagnostic." + str(uuid.uuid4())
    capability = "spawnpointDiagnostic" + str(uuid.uuid4())
    scratch = tempfile.mkdtemp(prefix="spawnpoint-native-")
    executable = str(Path(scratch) / "LibraryProbe.exe")
    shutil.copyfile(Path(os.environ["RUNNER_TEMP"]) / "spawnpoint-library-probe.exe", executable)
    # The alternate policies apply only to this disposable native fixture,
    # never Java or candidate mods, and never any existing container.
    box.advapi.SetSecurityInfo = (lambda *args: 0 if args[1] == 4 else security(*args)) if variant == "default-registry-lpac" else security
    box.k32.UpdateProcThreadAttribute = (lambda *args: 1 if args[2] == 0x2000F else attribute(*args)) if variant == "protected-appcontainer" else attribute
    box.create_container(name)
    restore = []
    try:
        print("PREREQUISITE", variant, flush=True)
        if variant == "tcp-device-lpac":
            for device in ("Tcp", "Tcp6"):
                path = "\\\\?\\GLOBALROOT\\Device\\" + device
                descriptor, old, updated = box.c.c_void_p(), box.c.c_void_p(), box.c.c_void_p()
                error = box.advapi.GetNamedSecurityInfoW(path, 1, 4, None, None, box.c.byref(old), None, box.c.byref(descriptor))
                if error:
                    raise box.c.WinError(error)
                restore.append((path, old, descriptor))
                entry = Access(0x1201BF, 1, 0, Trustee(None, 0, 0, 0, box.capability(capability)))
                error = box.advapi.SetEntriesInAclW(1, box.c.byref(entry), old, box.c.byref(updated))
                if not error:
                    error = box.advapi.SetNamedSecurityInfoW(path, 1, 4, None, None, updated, None)
                if updated:
                    box.k32.LocalFree(updated)
                if error:
                    raise box.c.WinError(error)
        sys.argv = [str(source), "--name", name, "--mem-mb", "512", "--cwd", scratch,
                    "--capability", capability, "--write", scratch,
                    "--read", os.environ["JAVA_HOME"], "--", executable, str(Path(os.environ["JAVA_HOME"]) / "bin")]
        try:
            box.main()
        except SystemExit as error:
            if error.code:
                raise
    finally:
        for path, old, descriptor in restore:
            error = box.advapi.SetNamedSecurityInfoW(path, 1, 4, None, None, old, None)
            box.k32.LocalFree(descriptor)
            if error:
                raise box.c.WinError(error)
        if box.userenv.DeleteAppContainerProfile(name):
            raise OSError("diagnostic profile cleanup failed")
        shutil.rmtree(scratch)
