# Agent Note: Win32 UTF-16 path truncation in the native folder picker

Status: implemented

English | [中文](2026-08-27-win32-utf16-nul-truncation.zh.md)

## Problem

`readUtf16` in the native directory-picker bindings scans a COM `PWSTR` for its NUL terminator by testing only each code unit's **low byte**: `bytes[end] !== 0`. A UTF-16LE NUL is a pair of zero bytes, so any BMP code unit whose low byte is zero — every U+XX00 character, such as 开 (U+5F00, bytes `00 5F`), 一 (U+4E00), 退 (U+9000) — is mistaken for the end of the string. Picking a folder whose path contains such a character returns the path truncated at that character, and the following `workspace.create` fails with `workspace-invalid-path` because the truncated path does not exist: the Web GUI shows the folder-error dialog and the workspace cannot be added. Reported upstream as [discussion #563](https://github.com/deepseek-ai/deepseek-harness/discussions/563) and [discussion #580](https://github.com/deepseek-ai/deepseek-harness/discussions/580).

## Decision

`readUtf16` terminates the scan only on the two-zero-byte pair: `(bytes[end] !== 0 || bytes[end + 1] !== 0)`. A lone zero low byte is a valid code unit and the scan continues, so paths containing U+XX00 characters are read whole. The `koffi.view(address, 32768)` read bound is unchanged: the function still reads one fixed window, which covers every path reachable through the folder dialog; the same two-byte test also stops correctly on the first real terminator within the window.

## Verification

The fake-COM suite (`win32-dialog-bindings.spec.ts`) gains a case whose dialog path is `C:\选中\开目录` (U+5F00): `runFolderDialog` must return the complete path. Before the fix the scan returned the truncated prefix; the test goes red on the old scan and green on the new one. The full directory-picker test set passes on this host, including the real win32 open-and-abort smoke. The built `lib/worker.cjs` (the artifact that runs the dialog) is rebuilt so installed consumers receive the fix; the ESM driver bundle is unaffected (the string reader lives only in the worker entry).

## Alternatives considered

**Keep the low-byte-only scan.** Wrong for every U+XX00 path; the truncation is silent, so the failure surfaces later as a confusing `workspace-invalid-path` error.

**Decode the out-pointer with `koffi.decode(addr, 'str16')`.** Rejected when `readUtf16` was introduced: the out-param is a raw address and decoding it as a pointer crashes on real Windows. The direct memory view stays.

**Scan growing view windows so paths beyond 16 KiB code units survive.** The folder dialog cannot practically produce such a path, and unbounded reads of COM-owned memory would trade a theoretical truncation for a fault risk; the fixed window stays.

## Consequences

Folders whose paths contain U+XX00 BMP characters can be picked and registered as workspaces. Pure-ASCII paths behave exactly as before. No wire, durable, or configuration format changes; no migration. The fix is one condition in one function plus a regression test, matching the cherry-pick proposed in discussion #580.
