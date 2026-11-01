#include <windows.h>
#include <stdio.h>

/* Temporary diagnostic: public runtime libraries only, no user data. */
int wmain(int argc, wchar_t **argv) {
    if (argc != 2) return 2;
    SetDllDirectoryW(argv[1]);
    const wchar_t *names[] = { L"vcruntime140.dll", L"vcruntime140_1.dll", L"msvcp140.dll",
        L"ADVAPI32.dll", L"USER32.dll", L"WINMM.dll", L"WS2_32.dll", L"VERSION.dll", L"dbghelp.dll", L"server\\jvm.dll" };
    for (unsigned i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        wchar_t path[32768];
        if (i < 3 || i == 9) swprintf_s(path, 32768, L"%ls\\%ls", argv[1], names[i]);
        else swprintf_s(path, 32768, L"%ls", names[i]);
        SetLastError(0);
        HMODULE module = LoadLibraryW(path);
        DWORD error = GetLastError();
        wprintf(L"LOAD %ls %ls error=%lu\n", names[i], module ? L"OK" : L"FAILED", error);
        fflush(stdout);
    }
    return 0;
}
