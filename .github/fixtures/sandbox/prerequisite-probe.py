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
for variant in ("protected-lpac", "default-registry-lpac", "protected-appcontainer"):
    name = "Spawnpoint.Diagnostic." + str(uuid.uuid4())
    scratch = tempfile.mkdtemp(prefix="spawnpoint-native-")
    executable = str(Path(scratch) / "LibraryProbe.exe")
    shutil.copyfile(Path(os.environ["RUNNER_TEMP"]) / "spawnpoint-library-probe.exe", executable)
    # The alternate policies apply only to this disposable native fixture,
    # never Java or candidate mods, and never any existing container.
    box.advapi.SetSecurityInfo = (lambda *args: 0 if args[1] == 4 else security(*args)) if variant == "default-registry-lpac" else security
    box.k32.UpdateProcThreadAttribute = (lambda *args: 1 if args[2] == 0x2000F else attribute(*args)) if variant == "protected-appcontainer" else attribute
    box.create_container(name)
    try:
        print("PREREQUISITE", variant, flush=True)
        sys.argv = [str(source), "--name", name, "--mem-mb", "512", "--cwd", scratch,
                    "--capability", "spawnpointDiagnostic" + str(uuid.uuid4()), "--write", scratch,
                    "--read", os.environ["JAVA_HOME"], "--", executable, str(Path(os.environ["JAVA_HOME"]) / "bin")]
        try:
            box.main()
        except SystemExit as error:
            if error.code:
                raise
    finally:
        if box.userenv.DeleteAppContainerProfile(name):
            raise OSError("diagnostic profile cleanup failed")
        shutil.rmtree(scratch)
