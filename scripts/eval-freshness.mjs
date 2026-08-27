// scripts/eval-freshness.mjs
//
// Pure decision logic for the release eval gate. CI cannot cover this: it runs
// `eval:dry`, which validates fixture structure and makes no model calls, so a
// prompt whose numbered steps contradict each other passes every check the
// matrix has. That happened, shipped, and was only caught by running a model
// against it.
//
// Kept free of fs/git calls so it can be unit tested; release.mjs collects the
// timestamps and hands them to evaluateEvalFreshness().

/**
 * Agents that drive the SHIPPED prompt. A run from any other adapter proves
 * nothing about it: `claude-cli` carries its own frozen preamble, deliberately
 * not tracking `buildAddressCommentsPrompt`, which is how a defect in the real
 * wording once reached a user unnoticed.
 */
export const SHIPPED_PROMPT_AGENTS = ['claude-cli-remove', 'claude-cli-resolve'];

/**
 * Parse an `eval/results/` directory name into a run descriptor.
 * Shape: `<timestamp>_<agent>_<format>`, e.g.
 * `2026-08-27T07-03-32_claude-cli-remove_current`. The agent name contains
 * hyphens, so the split is on `_`, never on `-`.
 *
 * @returns {{name: string, agent: string, format: string, ranAt: number}|null}
 *   `ranAt` is epoch seconds. Null when the name does not parse, so a stray
 *   directory is ignored rather than counted as a run.
 */
export function parseRunDirName(name) {
  const parts = String(name).split('_');
  if (parts.length !== 3) return null;
  const [stamp, agent, format] = parts;
  // 2026-08-27T07-03-32 -> 2026-08-27T07:03:32
  const iso = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
  if (iso === stamp) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  if (!agent || !format) return null;
  return { name, agent, format, ranAt: Math.floor(ms / 1000) };
}

/**
 * @param {Array<{path: string, changedAt: number|null}>} watched - Files whose
 *   content is the agent-facing contract, with the epoch-seconds commit time of
 *   the last change to each. A null `changedAt` means the file has no history
 *   yet and cannot make anything stale.
 * @param {Array<{agent: string, ranAt: number}>} runs - Parsed eval results.
 * @param {{requiredAgents?: string[]}} [options]
 * @returns {{ok: boolean, reason: 'fresh'|'no-runs'|'stale', message: string,
 *   stale?: Array<{agent: string, missing: boolean, behind: string[]}>}}
 */
export function evaluateEvalFreshness(
  watched,
  runs,
  { requiredAgents = SHIPPED_PROMPT_AGENTS } = {},
) {
  const changed = (watched ?? []).filter((w) => typeof w.changedAt === 'number');
  if (changed.length === 0) {
    return {
      ok: true,
      reason: 'fresh',
      message: 'No agent-facing files tracked; nothing to gate.',
    };
  }

  const newestByAgent = new Map();
  for (const r of runs ?? []) {
    if (!r || typeof r.ranAt !== 'number') continue;
    const prev = newestByAgent.get(r.agent);
    if (prev === undefined || r.ranAt > prev) newestByAgent.set(r.agent, r.ranAt);
  }

  if (requiredAgents.every((a) => !newestByAgent.has(a))) {
    return {
      ok: false,
      reason: 'no-runs',
      message:
        `No eval results from a shipped-prompt agent (${requiredAgents.join(', ')}). ` +
        `Run \`npm run eval -- --agent ${requiredAgents[0]}\` before releasing.`,
    };
  }

  const stale = [];
  for (const agent of requiredAgents) {
    const ranAt = newestByAgent.get(agent);
    if (ranAt === undefined) {
      stale.push({ agent, missing: true, behind: changed.map((w) => w.path) });
      continue;
    }
    const behind = changed.filter((w) => w.changedAt > ranAt).map((w) => w.path);
    if (behind.length > 0) stale.push({ agent, missing: false, behind });
  }

  if (stale.length === 0) {
    return {
      ok: true,
      reason: 'fresh',
      message: `Eval is current for ${requiredAgents.join(', ')}.`,
    };
  }

  const lines = stale.map((s) =>
    s.missing
      ? `  ${s.agent}: never run`
      : `  ${s.agent}: last run predates ${s.behind.join(', ')}`,
  );
  return {
    ok: false,
    reason: 'stale',
    message: `Eval has not been run against the current agent-facing text:\n${lines.join('\n')}`,
    stale,
  };
}
