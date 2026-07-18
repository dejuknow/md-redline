import { describe, expect, it } from 'vitest';

import { buildWindowsCommand } from './spawn-command.js';

describe('buildWindowsCommand', () => {
  it('quotes the node executable path when it contains spaces', () => {
    // A stock Windows Node install lives under "C:\Program Files". Joining
    // unquoted made cmd.exe execute "C:\Program", so the server child died
    // instantly and the CLI reported "app failed to start".
    const cmd = buildWindowsCommand('C:\\Program Files\\nodejs\\node.exe', [
      'C:\\Users\\dejuk\\AppData\\Roaming\\npm\\node_modules\\md-redline\\dist\\server.js',
    ]);
    expect(cmd).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\dejuk\\AppData\\Roaming\\npm\\node_modules\\md-redline\\dist\\server.js',
    );
  });

  it('quotes target paths containing spaces', () => {
    const cmd = buildWindowsCommand('C:\\nodejs\\node.exe', [
      'C:\\mdr\\dist\\server.js',
      'C:\\Users\\John Smith\\specs',
    ]);
    expect(cmd).toBe('C:\\nodejs\\node.exe C:\\mdr\\dist\\server.js "C:\\Users\\John Smith\\specs"');
  });

  it('leaves the dev-mode npm invocation untouched', () => {
    expect(buildWindowsCommand('npm.cmd', ['run', 'dev'])).toBe('npm.cmd run dev');
  });

  it('renders an empty arg as "" so `start` keeps its title placeholder', () => {
    // openInBrowser spawns: cmd /c start "" <url>. The empty title arg must
    // survive as "" or `start` would treat a quoted URL as the window title.
    const cmd = buildWindowsCommand('cmd', ['/c', 'start', '', 'http://127.0.0.1:5188']);
    expect(cmd).toBe('cmd /c start "" http://127.0.0.1:5188');
  });

  it('quotes args containing cmd metacharacters or delimiters', () => {
    // & would chain a second command; = is a cmd/start token delimiter.
    expect(buildWindowsCommand('C:\\nodejs\\node.exe', ['C:\\repos\\a&b\\dist\\server.js'])).toBe(
      'C:\\nodejs\\node.exe "C:\\repos\\a&b\\dist\\server.js"',
    );
    expect(
      buildWindowsCommand('cmd', ['/c', 'start', '', 'http://127.0.0.1:5188?file=C%3A%5Cspec.md']),
    ).toBe('cmd /c start "" "http://127.0.0.1:5188?file=C%3A%5Cspec.md"');
  });
});
