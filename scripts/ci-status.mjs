// scripts/ci-status.mjs
//
// Pure decision logic for the release CI gate. Given the check runs GitHub
// reports for a commit (the shape returned by
// GET /repos/{owner}/{repo}/commits/{sha}/check-runs), decide whether the
// commit is safe to release. Kept free of any network/gh calls so it can be
// unit tested; release.mjs does the gh api call and hands the parsed
// check_runs array to evaluateCiRuns().

// GitHub check-run conclusions that do not block a release. failure,
// cancelled, timed_out, action_required and stale all block; a null
// conclusion only appears while a run is still in flight (caught as pending).
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * @param {Array<{name?: string, status?: string, conclusion?: string|null, app?: {slug?: string}}>} checkRuns
 * @param {{requiredApp?: string|null}} [options] - Only gate on check runs from
 *   this GitHub App slug (default 'github-actions'), so unrelated third-party
 *   checks never block a release. Pass null to consider every check run.
 * @returns {{ok: boolean, reason: 'green'|'no-runs'|'pending'|'failed', message: string, names?: string[], count?: number}}
 */
export function evaluateCiRuns(checkRuns, { requiredApp = 'github-actions' } = {}) {
  const runs = (checkRuns ?? []).filter(
    (r) => !requiredApp || r?.app?.slug === requiredApp,
  );

  if (runs.length === 0) {
    return {
      ok: false,
      reason: 'no-runs',
      message: requiredApp
        ? `No ${requiredApp} check runs found for this commit. Push it and let CI run first.`
        : 'No check runs found for this commit. Push it and let CI run first.',
    };
  }

  const pending = runs.filter((r) => r.status !== 'completed');
  if (pending.length > 0) {
    const names = pending.map((r) => r.name ?? '(unnamed)');
    return {
      ok: false,
      reason: 'pending',
      message: `CI is still running: ${names.join(', ')}. Wait for it to finish, then retry.`,
      names,
    };
  }

  const failed = runs.filter((r) => !PASSING_CONCLUSIONS.has(r.conclusion));
  if (failed.length > 0) {
    const names = failed.map((r) => `${r.name ?? '(unnamed)'} (${r.conclusion})`);
    return {
      ok: false,
      reason: 'failed',
      message: `CI is not green: ${names.join(', ')}. Fix it and let CI go green before releasing.`,
      names,
    };
  }

  return {
    ok: true,
    reason: 'green',
    message: `CI is green (${runs.length} check${runs.length === 1 ? '' : 's'} passed).`,
    count: runs.length,
  };
}
