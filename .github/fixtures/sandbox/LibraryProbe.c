#include <winsock2.h>
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <userenv.h>
#include <stdio.h>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "userenv.lib")

/* Temporary diagnostic: public runtime libraries only, no user data. */
int wmain(int argc, wchar_t **argv) {
    if (argc == 3 && !wcscmp(argv[1], L"--peer")) {
        DWORD pid = wcstoul(argv[2], NULL, 10);
        const DWORD rights[] = { PROCESS_VM_READ, PROCESS_VM_WRITE | PROCESS_VM_OPERATION, PROCESS_DUP_HANDLE };
        const char *names[] = { "peer-memory-read", "peer-memory-write", "peer-handle-duplicate" };
        for (unsigned i = 0; i < 3; i++) {
            HANDLE process = OpenProcess(rights[i], FALSE, pid);
            printf("ACCESS %s %s\n", names[i], process ? "ALLOWED" : "DENIED");
            if (process) CloseHandle(process);
        }
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid), token = NULL;
        BOOL allowed = process && OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE, &token);
        printf("ACCESS peer-token-duplicate %s\n", allowed ? "ALLOWED" : "DENIED");
        if (token) CloseHandle(token);
        if (process) CloseHandle(process);
        return 0;
    }
    if (argc != 2) return 2;
    if (!wcscmp(argv[1], L"--device-acl")) {
        wchar_t *names[] = { L"\\\\?\\GLOBALROOT\\Device\\Afd", L"\\\\?\\GLOBALROOT\\Device\\Nsi" };
        for (unsigned i = 0; i < 2; i++) {
            PSECURITY_DESCRIPTOR descriptor = NULL;
            DWORD error = GetNamedSecurityInfoW(names[i], SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, NULL, NULL, &descriptor);
            wprintf(L"DEVICE %ls error=%lu\n", names[i], error);
            LPWSTR text;
            if (!error && ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &text, NULL)) {
                wprintf(L"ACL %ls\n", text);
                LocalFree(text);
            }
            if (descriptor) LocalFree(descriptor);
        }
        return 0;
    }
    HANDLE token;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        DWORD value = 0, size = 0;
        GetTokenInformation(token, TokenIsAppContainer, &value, sizeof(value), &size);
        printf("TOKEN AppContainer=%lu\n", value);
        GetTokenInformation(token, TokenIsLessPrivilegedAppContainer, &value, sizeof(value), &size);
        printf("TOKEN LPAC=%lu\n", value);
        BYTE buffer[1024];
        if (GetTokenInformation(token, TokenAppContainerSid, buffer, sizeof(buffer), &size)) {
            LPWSTR text;
            if (ConvertSidToStringSidW(((TOKEN_APPCONTAINER_INFORMATION *)buffer)->TokenAppContainer, &text)) {
                wprintf(L"TOKEN SID=%ls\n", text);
                LocalFree(text);
            }
        }
        CloseHandle(token);
    }
    HKEY registry;
    HRESULT location = GetAppContainerRegistryLocation(KEY_READ | KEY_CREATE_SUB_KEY, &registry);
    printf("PROFILE registry-open=%ld\n", location);
    if (SUCCEEDED(location)) {
        typedef LONG (WINAPI *QueryKey)(HANDLE, ULONG, PVOID, ULONG, PULONG);
        QueryKey query = (QueryKey)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryKey");
        BYTE name[8192]; ULONG size;
        if (query && query(registry, 3, name, sizeof(name), &size) == 0)
            wprintf(L"PROFILE registry-path=%.*ls\n", *(ULONG *)name / 2, (wchar_t *)(name + sizeof(ULONG)));
        HKEY probe;
        LSTATUS result = RegCreateKeyExW(registry, L"SpawnpointBoundaryProbe", 0, NULL, 0, KEY_SET_VALUE, NULL, &probe, NULL);
        printf("PROFILE registry-create=%ld\n", result);
        if (!result) {
            DWORD value = 42;
            printf("PROFILE registry-write=%ld\n", RegSetValueExW(probe, L"control", 0, REG_DWORD, (BYTE *)&value, sizeof(value)));
            RegCloseKey(probe);
            RegDeleteKeyW(registry, L"SpawnpointBoundaryProbe");
        }
        RegCloseKey(registry);
    }
    WSADATA data;
    printf("WSAStartup=%d\n", WSAStartup(MAKEWORD(2, 2), &data));
    SOCKET ipv4 = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    printf("SOCKET IPv4=%d error=%d\n", ipv4 != INVALID_SOCKET, WSAGetLastError());
    if (ipv4 != INVALID_SOCKET) closesocket(ipv4);
    SOCKET ipv6 = socket(AF_INET6, SOCK_STREAM, IPPROTO_TCP);
    printf("SOCKET IPv6=%d error=%d\n", ipv6 != INVALID_SOCKET, WSAGetLastError());
    if (ipv6 != INVALID_SOCKET) closesocket(ipv6);
    WSACleanup();
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
