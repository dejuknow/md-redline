import { describe, it, expect } from 'vitest';
import { decideSkip } from './case-selection';

const base = {
  caseName: 'case',
  caseMode: 'remove' as const,
  requiresAgent: undefined,
  agentName: 'claude-cli-remove',
  agentMode: 'remove' as const,
};

describe('decideSkip', () => {
  it('runs a case whose mode the agent produces', () => {
    expect(decideSkip(base)).toEqual({ skip: false });
  });

  it('skips a remove-mode case under a resolve-mode agent', () => {
    // Running it anyway fails every marker by construction: the agent was told
    // to resolve them and the case expects them gone. That is not a
    // measurement, and it dragged a full-suite average to 79% on 15 cases that
    // were simply asked the wrong question.
    const d = decideSkip({
      ...base,
      agentName: 'claude-cli-resolve',
      agentMode: 'resolve',
    });
    expect(d).toMatchObject({ skip: true, reason: 'mode' });
  });

  it('skips a resolve-mode case under a remove-mode agent', () => {
    const d = decideSkip({ ...base, caseMode: 'resolve' });
    expect(d).toMatchObject({ skip: true, reason: 'mode' });
  });

  it('treats a missing markerMode as remove, matching the scorer', () => {
    expect(decideSkip({ ...base, caseMode: undefined })).toEqual({ skip: false });
    expect(
      decideSkip({
        ...base,
        caseMode: undefined,
        agentName: 'claude-cli-resolve',
        agentMode: 'resolve',
      }),
    ).toMatchObject({ skip: true, reason: 'mode' });
  });

  it('pins a case to one adapter when requiresAgent names a different one', () => {
    // Same mode, different instructions: claude-cli shares remove mode with
    // claude-cli-remove but carries a frozen preamble, so a case measuring the
    // shipped prompt must not be scored by it.
    const d = decideSkip({ ...base, requiresAgent: 'claude-cli-remove', agentName: 'claude-cli' });
    expect(d).toMatchObject({ skip: true, reason: 'agent' });
  });

  it('runs when requiresAgent names the selected agent', () => {
    expect(decideSkip({ ...base, requiresAgent: 'claude-cli-remove' })).toEqual({ skip: false });
  });

  it('reports the agent reason before the mode reason', () => {
    // Both apply here. The agent mismatch is the more specific fact and makes
    // the more useful log line.
    const d = decideSkip({
      ...base,
      requiresAgent: 'claude-cli-remove',
      agentName: 'claude-cli-resolve',
      agentMode: 'resolve',
    });
    expect(d).toMatchObject({ skip: true, reason: 'agent' });
  });

  it('names both sides in the message, so a skip is diagnosable from the log', () => {
    const d = decideSkip({ ...base, caseMode: 'resolve' });
    if (!d.skip) throw new Error('expected a skip');
    expect(d.message).toContain('resolve-mode case');
    expect(d.message).toContain('claude-cli-remove');
  });
});
