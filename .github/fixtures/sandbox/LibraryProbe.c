#include <windows.h>
#include <stdio.h>

/* Temporary diagnostic: public runtime libraries only, no user data. */
int wmain(int argc, wchar_t **argv) {
    if (argc != 2) return 2;
    SetDllDirectoryW(argv[1]);
    const wchar_t *names[] = { L"vcruntime140.dll", L"vcruntime140_1.dll", L"msvcp140.dll",
        L"ADVAPI32.dll", L"USER32.dll", L"WINMM.dll", L"WS2_32.dll", L"VERSION.dll", L"dbghelp.dll", L"POWRPROF.dll", L"server\\jvm.dll" };
    for (unsigned i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        wchar_t path[32768];
        if (i < 3 || i == 10) swprintf_s(path, 32768, L"%ls\\%ls", argv[1], names[i]);
        else {
            wchar_t system[32768];
            GetSystemDirectoryW(system, 32768);
            swprintf_s(path, 32768, L"%ls\\%ls", system, names[i]);
        }
        HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
        wprintf(L"READ %ls %ls error=%lu\n", names[i], file != INVALID_HANDLE_VALUE ? L"OK" : L"FAILED", GetLastError());
        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        SetLastError(0);
        HMODULE module = LoadLibraryW(path);
        DWORD error = GetLastError();
        wprintf(L"LOAD %ls %ls error=%lu\n", names[i], module ? L"OK" : L"FAILED", error);
        fflush(stdout);
    }
    return 0;
}
