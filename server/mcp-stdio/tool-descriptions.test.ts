import { describe, expect, it } from 'vitest';
import { MDR_TOOLS } from './server';

/**
 * The tool descriptions are the only thing that decides which tool an agent
 * reaches for, and the two review tools are named from opposite points of
 * view: mdr_comment is the agent reviewing, mdr_request_review is the human
 * reviewing. "I want to review analytics.md in mdr" therefore points at the
 * wrong one, and the failure is not quiet: mdr_comment writes comment markers
 * into a file the user only wanted to read.
 */
function describeOf(name: string): string {
  const tool = MDR_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not advertised`);
  return tool.description;
}

describe('review tool disambiguation', () => {
  it('does not open mdr_comment on a phrase that matches "review X in mdr"', () => {
    // The original opening was "Review markdown files in md-redline (mdr) and
    // leave inline feedback", a near-verbatim match for what a user types when
    // they mean the opposite tool.
    const first = describeOf('mdr_comment').split('\n')[0];
    expect(first).not.toMatch(/^Review markdown files in md-redline/);
  });

  it('says whose comments mdr_comment posts, in its first sentence', () => {
    const first = describeOf('mdr_comment').split('.')[0];
    expect(first).toMatch(/YOUR OWN/);
  });

  it('routes the user-is-reviewer phrasings from mdr_comment to mdr_request_review', () => {
    const d = describeOf('mdr_comment');
    expect(d).toContain('mdr_request_review');
    expect(d).toMatch(/I want to review/);
  });

  it('has mdr_request_review claim those phrasings itself', () => {
    const d = describeOf('mdr_request_review');
    expect(d).toMatch(/I want to review/);
    expect(d).toMatch(/USER/);
  });

  it('still advertises all four tools', () => {
    expect(MDR_TOOLS.map((t) => t.name).sort()).toEqual([
      'mdr_ask',
      'mdr_comment',
      'mdr_request_review',
      'mdr_wait',
    ]);
  });
});

describe('the old tool name', () => {
  it('is not advertised, so it cannot compete for "review X in mdr"', () => {
    expect(MDR_TOOLS.map((t) => t.name)).not.toContain('mdr_review');
  });
});
