import { describe, expect, it } from 'vitest';
import { buildHighlightedHtml } from './RawView';

const marker =
  '<!-- @comment{"id":"c1","author":"Dennis","text":"Tighten this paragraph considerably please","anchor":"foo"} -->';

describe('buildHighlightedHtml comment marker folding', () => {
  it('folds a marker into a pill with the JSON hidden alongside', () => {
    const html = buildHighlightedHtml(`before\n${marker}\nafter`);
    expect(html).toContain('raw-comment-marker raw-marker-folded');
    expect(html).toContain('data-comment-id="c1"');
    // full summary is 50 chars; slice(0, 44) ends on the space after
    // "considerably", which trimEnd removes before the ellipsis
    expect(html).toContain(
      '<span class="raw-marker-pill">Dennis: Tighten this paragraph considerably…</span>',
    );
    expect(html).toContain('raw-marker-json');
    expect(html).toContain('@comment'); // JSON still present for expand
  });

  it('keeps the summary on one whitespace-collapsed line', () => {
    const multiline =
      '<!-- @comment{"id":"c2","author":"A","text":"line one\\nline two","anchor":"x"} -->';
    const html = buildHighlightedHtml(multiline);
    expect(html).toContain('A: line one line two');
  });

  it('leaves a marker with unparseable JSON unfolded', () => {
    const html = buildHighlightedHtml('<!-- @comment{not json} -->');
    expect(html).toContain('raw-comment-marker');
    expect(html).not.toContain('raw-marker-folded');
    expect(html).not.toContain('raw-marker-pill');
  });
});

describe('buildHighlightedHtml and marker-shaped text in code (#123)', () => {
  it('shows a documentation example of the format as code, not a folded comment', () => {
    const html = buildHighlightedHtml(
      'Write `<!-- @comment{"id":"x","anchor":"y"} -->` to leave a note.',
    );
    expect(html).not.toContain('raw-comment-marker');
    expect(html).not.toContain('data-comment-id="x"');
  });

  it('still folds a real marker next to such an example', () => {
    const html = buildHighlightedHtml(
      `Write \`<!-- @comment{"id":"x","anchor":"y"} -->\` then ${marker}foo`,
    );
    expect(html).toContain('data-comment-id="c1"');
    expect(html).not.toContain('data-comment-id="x"');
  });
});

describe('extractRawHeadings and marker-shaped text in code (#123)', () => {
  it('keeps a documentation example in the heading text, like the rendered view', async () => {
    const { extractRawHeadings } = await import('./RawView');
    const [heading] = extractRawHeadings('## The `<!-- @comment{"id":"x"} -->` form\n');
    expect(heading.text).toBe('The <!-- @comment{"id":"x"} --> form');
  });
});
