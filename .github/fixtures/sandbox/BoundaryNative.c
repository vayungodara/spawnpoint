#include <windows.h>
#include <userenv.h>
#include <stdio.h>
#include <stdlib.h>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")

/* Only harness-created processes and their disposable profiles are probed. */
int wmain(int argc, wchar_t **argv) {
    if (argc == 3 && !wcscmp(argv[1], L"--peer")) {
        DWORD pid = wcstoul(argv[2], NULL, 10);
        const DWORD rights[] = { PROCESS_VM_READ, PROCESS_VM_WRITE | PROCESS_VM_OPERATION, PROCESS_DUP_HANDLE };
        const char *names[] = { "peer-memory-read", "peer-memory-write", "peer-handle-duplicate" };
        for (unsigned i = 0; i < 3; i++) {
            HANDLE process = OpenProcess(rights[i], FALSE, pid);
            if (!process && GetLastError() != ERROR_ACCESS_DENIED) return 4;
            printf("ACCESS %s %s\n", names[i], process ? "ALLOWED" : "DENIED");
            if (process) CloseHandle(process);
        }
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid), token = NULL;
        if (!process && GetLastError() != ERROR_ACCESS_DENIED) return 4;
        BOOL allowed = process && OpenProcessToken(process, TOKEN_DUPLICATE, &token);
        if (process && !allowed && GetLastError() != ERROR_ACCESS_DENIED) return 4;
        printf("ACCESS peer-token-duplicate %s\n", allowed ? "ALLOWED" : "DENIED");
        if (token) CloseHandle(token);
        if (process) CloseHandle(process);
        return 0;
    }
    if (argc != 2 || wcscmp(argv[1], L"--profile")) return 2;
    HANDLE token;
    DWORD value = 0, size = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 3;
    BOOL queried = GetTokenInformation(token, TokenIsAppContainer, &value, sizeof(value), &size);
    CloseHandle(token);
    if (!queried || value != 1) return 3;
    const REGSAM rights[] = { KEY_QUERY_VALUE, KEY_SET_VALUE, KEY_CREATE_SUB_KEY };
    const char *names[] = { "profile-registry-read", "profile-registry-write", "profile-registry-create" };
    for (unsigned i = 0; i < 3; i++) {
        HKEY registry;
        HRESULT result = GetAppContainerRegistryLocation(rights[i], &registry);
        if (result != S_OK && result != E_ACCESSDENIED) return 4;
        printf("ACCESS %s %s\n", names[i], SUCCEEDED(result) ? "ALLOWED" : "DENIED");
        if (SUCCEEDED(result)) RegCloseKey(registry);
    }
    return 0;
}
