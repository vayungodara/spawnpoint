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
attribute = box.k32.UpdateProcThreadAttribute
create = box.k32.CreateProcessW
box.advapi.ConvertStringSidToSidW.argtypes = [box.w.LPCWSTR, box.c.POINTER(box.c.c_void_p)]
box.advapi.CreateRestrictedToken.argtypes = [box.w.HANDLE, box.w.DWORD, box.w.DWORD, box.c.c_void_p,
                                          box.w.DWORD, box.c.c_void_p, box.w.DWORD, box.c.c_void_p,
                                          box.c.POINTER(box.w.HANDLE)]

for variant in ("protected-lpac", "protected-appcontainer", "restricted-appcontainer"):
    name = "Spawnpoint.Diagnostic." + str(uuid.uuid4())
    capability = "spawnpointDiagnostic" + str(uuid.uuid4())
    scratch = tempfile.mkdtemp(prefix="spawnpoint-native-")
    executable = str(Path(scratch) / "LibraryProbe.exe")
    shutil.copyfile(Path(os.environ["RUNNER_TEMP"]) / "spawnpoint-library-probe.exe", executable)
    # The alternate policies apply only to this disposable native fixture,
    # never Java or candidate mods, and never any existing container.
    box.k32.UpdateProcThreadAttribute = (lambda *args: 1 if args[2] == 0x2000F else attribute(*args)) if variant.endswith("appcontainer") else attribute
    box.k32.CreateProcessW = create
    box.create_container(name)
    tokens, sids = [], []
    try:
        print("PREREQUISITE", variant, flush=True)
        if variant == "restricted-appcontainer":
            for text in ("S-1-5-12", "S-1-15-2-2"):
                sid = box.c.c_void_p()
                box.check(box.advapi.ConvertStringSidToSidW(text, box.c.byref(sid)))
                sids.append(sid)
            restricted_sids = (box.SIDATTR * 5)(
                box.SIDATTR(sids[0], 0), box.SIDATTR(sids[1], 0),
                box.SIDATTR(box.capability(capability), 0),
                box.SIDATTR(box.capability("spawnpointRuntimeRead"), 0),
                box.SIDATTR(box.capability("registryRead"), 0))
            original, restricted = box.w.HANDLE(), box.w.HANDLE()
            box.check(box.advapi.OpenProcessToken(box.w.HANDLE(-1), 0xF01FF, box.c.byref(original)))
            tokens.append(original)
            box.check(box.advapi.CreateRestrictedToken(original, 1, 0, None, 0, None, 5, restricted_sids, box.c.byref(restricted)))
            tokens.append(restricted)
            def restricted_create(*args):
                box.advapi.CreateProcessAsUserW.argtypes = [box.w.HANDLE, *box.k32.CreateProcessW.argtypes]
                return box.advapi.CreateProcessAsUserW(restricted, *args)
            box.k32.CreateProcessW = restricted_create
        sys.argv = [str(source), "--name", name, "--mem-mb", "512", "--cwd", scratch,
                    "--capability", capability, "--write", scratch,
                    "--read", os.environ["JAVA_HOME"], "--", executable, str(Path(os.environ["JAVA_HOME"]) / "bin")]
        try:
            box.main()
        except SystemExit as error:
            if error.code:
                raise
    finally:
        for token in tokens:
            box.k32.CloseHandle(token)
        for sid in sids:
            box.k32.LocalFree(sid)
        if box.userenv.DeleteAppContainerProfile(name):
            raise OSError("diagnostic profile cleanup failed")
        shutil.rmtree(scratch)
