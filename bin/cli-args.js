/**
 * Parse mdr CLI arguments into flags and a positional target.
 *
 * Unknown dash-args are reported via `unknownOption` instead of being
 * silently treated as "not the file", and `--` ends flag parsing so
 * filenames starting with '-' stay reachable. Positional subcommands and
 * first-arg-only options (--stop, --restrict, mcp, -h, -v) are intercepted
 * by main() before this runs.
 *
 * @param {string[]} args
 * @returns {{ noOpen: boolean; forceBrowser: boolean; positional: string; unknownOption: string | null }}
 */
export function parseCliArgs(args) {
  /** @type {{ noOpen: boolean; forceBrowser: boolean; positional: string; unknownOption: string | null }} */
  const result = { noOpen: false, forceBrowser: false, positional: '', unknownOption: null };
  /** @type {string[]} */
  const positionals = [];
  let afterDoubleDash = false;
  for (const arg of args) {
    if (afterDoubleDash) {
      positionals.push(arg);
    } else if (arg === '--') {
      afterDoubleDash = true;
    } else if (arg === '--no-open') {
      result.noOpen = true;
    } else if (arg === '--browser') {
      result.forceBrowser = true;
    } else if (arg.startsWith('-')) {
      result.unknownOption = arg;
      return result;
    } else {
      positionals.push(arg);
    }
  }
  result.positional = positionals[0] ?? '';
  return result;
}
