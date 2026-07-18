import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Writes a platform-appropriate executable stub that stands in for a real
 * browser when the CLI is driven under test via the MDR_BROWSER override. The
 * CLI spawns it with the URL as its sole argument.
 *
 * With `markerPath`, the stub writes "LAUNCHED" there as its first action, so a
 * test can prove the launcher actually ran — and, under the Windows
 * detached-teardown race, that it survived the CLI exiting. Without it, the
 * stub is a pure no-op, used to keep other subprocess tests from opening a real
 * browser (shadowing `open` on PATH does not work on Windows, whose launcher is
 * `cmd /c start`).
 *
 * The URL is intentionally not written into the marker: a Windows batch file
 * would re-interpret the percent-escapes in it. URL and quoting correctness is
 * covered by buildWindowsCommand's own tests; this stub only proves the launch.
 */
export function createBrowserStub(dir: string, markerPath?: string): string {
  if (process.platform === 'win32') {
    const stub = join(dir, 'browser-stub.cmd');
    const body = markerPath
      ? `@echo off\r\n>"${markerPath}" echo LAUNCHED\r\n`
      : `@echo off\r\nexit /b 0\r\n`;
    writeFileSync(stub, body);
    return stub;
  }
  const stub = join(dir, 'browser-stub.sh');
  const body = markerPath ? `#!/bin/sh\nprintf LAUNCHED > "${markerPath}"\n` : `#!/bin/sh\nexit 0\n`;
  writeFileSync(stub, body);
  chmodSync(stub, 0o755);
  return stub;
}
