import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain .mjs helper without type declarations
import {
  evaluateEvalFreshness,
  parseRunDirName,
  SHIPPED_PROMPT_AGENTS,
} from './eval-freshness.mjs';

const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const PROMPT = 'src/lib/agent-prompts.ts';
const TOOLS = 'server/mcp-stdio/server.ts';

function run(agent: string, iso: string) {
  return { agent, ranAt: T(iso) };
}

describe('parseRunDirName', () => {
  it('reads the timestamp, agent and format out of a results directory', () => {
    expect(parseRunDirName('2026-08-27T07-03-32_claude-cli-remove_current')).toMatchObject({
      agent: 'claude-cli-remove',
      format: 'current',
      ranAt: T('2026-08-27T07:03:32Z'),
    });
  });

  it('reads the stamp as UTC whatever the machine timezone, because the runner writes UTC', () => {
    // eval/runner.ts names the directory from toISOString(), which is UTC. A
    // parse that read it as local time shifted every run by the machine's
    // offset: on a UTC-7 machine a run 13 minutes BEFORE a prompt change
    // looked 7 hours after it, and the gate passed.
    const saved = process.env.TZ;
    try {
      for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
        process.env.TZ = tz;
        expect(parseRunDirName('2026-08-27T07-21-34_claude-cli-remove_current')?.ranAt).toBe(
          Math.floor(Date.UTC(2026, 7, 27, 7, 21, 34) / 1000),
        );
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('keeps hyphenated agent names intact', () => {
    // Splitting on '-' would turn claude-cli-remove into three fields and
    // silently attribute the run to an agent that does not exist.
    expect(parseRunDirName('2026-01-02T03-04-05_claude-cli-resolve_current')?.agent).toBe(
      'claude-cli-resolve',
    );
  });

  it('ignores anything that is not a run directory', () => {
    for (const bad of ['', 'README.md', 'two_parts', 'a_b_c_d', 'notatime_claude-cli_current']) {
      expect(parseRunDirName(bad)).toBeNull();
    }
  });
});

describe('evaluateEvalFreshness', () => {
  const bothFresh = [
    run('claude-cli-remove', '2026-08-27T10:00:00'),
    run('claude-cli-resolve', '2026-08-27T10:00:00'),
  ];

  it('passes when every required agent ran after the last prompt change', () => {
    const res = evaluateEvalFreshness(
      [{ path: PROMPT, changedAt: T('2026-08-27T09:00:00') }],
      bothFresh,
    );
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('fresh');
  });

  it('fails when the prompt changed after the newest run', () => {
    const res = evaluateEvalFreshness(
      [{ path: PROMPT, changedAt: T('2026-08-27T11:00:00') }],
      bothFresh,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('stale');
    expect(res.message).toContain(PROMPT);
  });

  it('fails when only one branch of the prompt has been exercised', () => {
    // Both modes ship. A remove-mode run says nothing about the resolve
    // wording, which is now the default a reader gets.
    const res = evaluateEvalFreshness(
      [{ path: PROMPT, changedAt: T('2026-08-27T09:00:00') }],
      [run('claude-cli-remove', '2026-08-27T10:00:00')],
    );
    expect(res.ok).toBe(false);
    expect(res.stale).toEqual([{ agent: 'claude-cli-resolve', missing: true, behind: [PROMPT] }]);
  });

  it('does not accept a run from the frozen baseline agent', () => {
    // `claude-cli` carries its own hardcoded preamble and deliberately does
    // not track the shipped prompt, so its score proves nothing about it.
    const res = evaluateEvalFreshness(
      [{ path: PROMPT, changedAt: T('2026-08-27T09:00:00') }],
      [run('claude-cli', '2026-08-27T23:00:00')],
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-runs');
  });

  it('gates on the tool descriptions too, not just the hand-off prompt', () => {
    // Tool descriptions are the same class of agent-facing text; a wrong one
    // sent "I want to review X" to the tool that posts the agent's own
    // comments.
    const res = evaluateEvalFreshness(
      [
        { path: PROMPT, changedAt: T('2026-08-27T09:00:00') },
        { path: TOOLS, changedAt: T('2026-08-27T11:00:00') },
      ],
      bothFresh,
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain(TOOLS);
    expect(res.message).not.toContain(PROMPT);
  });

  it('takes the newest run per agent, not the first it sees', () => {
    const res = evaluateEvalFreshness(
      [{ path: PROMPT, changedAt: T('2026-08-27T09:30:00') }],
      [
        run('claude-cli-remove', '2026-08-26T10:00:00'),
        run('claude-cli-remove', '2026-08-27T10:00:00'),
        run('claude-cli-resolve', '2026-08-27T10:00:00'),
      ],
    );
    expect(res.ok).toBe(true);
  });

  it('passes when no watched file has any history', () => {
    expect(evaluateEvalFreshness([{ path: PROMPT, changedAt: null }], []).ok).toBe(true);
  });

  it('reports no-runs when the results directory is empty', () => {
    const res = evaluateEvalFreshness([{ path: PROMPT, changedAt: T('2026-08-27T09:00:00') }], []);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-runs');
    expect(res.message).toContain('npm run eval');
  });

  it('exports the shipped-prompt agents it gates on', () => {
    expect(SHIPPED_PROMPT_AGENTS).toEqual(['claude-cli-remove', 'claude-cli-resolve']);
  });
});
