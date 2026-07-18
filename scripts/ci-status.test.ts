import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain .mjs helper without type declarations
import { evaluateCiRuns } from './ci-status.mjs';

const ga = { slug: 'github-actions' };

function ciRun(name: string, status: string, conclusion: string | null, app = ga) {
  return { name, status, conclusion, app };
}

// Mirrors the four jobs md-redline's CI reports per commit.
const greenMatrix = [
  ciRun('checks', 'completed', 'success'),
  ciRun('unit (macos-latest)', 'completed', 'success'),
  ciRun('unit (ubuntu-latest)', 'completed', 'success'),
  ciRun('unit (windows-latest)', 'completed', 'success'),
];

describe('evaluateCiRuns', () => {
  it('passes when every github-actions check succeeded', () => {
    const result = evaluateCiRuns(greenMatrix);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('green');
    expect(result.count).toBe(4);
  });

  it('blocks when a job failed (the 0.7.1 Windows regression)', () => {
    const runs = [
      ciRun('checks', 'completed', 'success'),
      ciRun('unit (macos-latest)', 'completed', 'success'),
      ciRun('unit (windows-latest)', 'completed', 'failure'),
    ];
    const result = evaluateCiRuns(runs);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('failed');
    expect(result.message).toContain('unit (windows-latest)');
  });

  it('blocks while any job is still running (e2e in the checks job)', () => {
    const runs = [
      ciRun('checks', 'in_progress', null),
      ciRun('unit (macos-latest)', 'completed', 'success'),
      ciRun('unit (windows-latest)', 'completed', 'success'),
    ];
    const result = evaluateCiRuns(runs);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('pending');
    expect(result.message).toContain('checks');
  });

  it('treats queued/waiting jobs as pending, not green', () => {
    const runs = [ciRun('unit (windows-latest)', 'queued', null)];
    const result = evaluateCiRuns(runs);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('pending');
  });

  it('blocks when the commit has no check runs at all', () => {
    expect(evaluateCiRuns([]).reason).toBe('no-runs');
    expect(evaluateCiRuns(undefined).reason).toBe('no-runs');
  });

  it('blocks when only non-actions checks exist (no CI ran)', () => {
    const runs = [ciRun('some-bot', 'completed', 'success', { slug: 'third-party-bot' })];
    const result = evaluateCiRuns(runs);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-runs');
  });

  it('ignores unrelated third-party checks and gates only on github-actions', () => {
    const runs = [
      ...greenMatrix,
      ciRun('coverage-bot', 'completed', 'failure', { slug: 'third-party-bot' }),
    ];
    const result = evaluateCiRuns(runs);
    expect(result.ok).toBe(true);
  });

  it('accepts neutral and skipped conclusions as passing', () => {
    const runs = [
      ciRun('unit (macos-latest)', 'completed', 'skipped'),
      ciRun('unit (windows-latest)', 'completed', 'neutral'),
    ];
    expect(evaluateCiRuns(runs).ok).toBe(true);
  });

  it('blocks on cancelled and timed_out conclusions', () => {
    expect(evaluateCiRuns([ciRun('checks', 'completed', 'cancelled')]).reason).toBe('failed');
    expect(evaluateCiRuns([ciRun('checks', 'completed', 'timed_out')]).reason).toBe('failed');
  });
});
