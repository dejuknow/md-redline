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
    expect(html).toContain('<span class="raw-marker-pill">Dennis: Tighten this paragraph considerably…</span>');
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
