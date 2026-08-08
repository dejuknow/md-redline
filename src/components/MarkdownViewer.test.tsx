// @vitest-environment jsdom

import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  MarkdownViewer,
  isInsideSvgTextContent,
  computeTableOverflow,
  matchTableScroll,
} from './MarkdownViewer';
import { renderMarkdown } from '../markdown/pipeline';
import { insertComment, parseComments } from '../lib/comment-parser';

describe('matchTableScroll', () => {
  it('restores offsets to the same tables when nothing changed', () => {
    const prior = [
      { key: 'a', scrollLeft: 100 },
      { key: 'b', scrollLeft: 50 },
    ];
    expect(matchTableScroll(prior, ['a', 'b'])).toEqual([100, 50]);
  });

  it('keeps an unchanged table at its offset when a table is inserted before it', () => {
    // The reviewer's desync scenario: a new table appears at index 0. Positional
    // restore would misapply 100 to the new table and reset the real one to 0;
    // identity keying keeps table "a" at 100 and starts the new "c" at 0.
    const prior = [
      { key: 'a', scrollLeft: 100 },
      { key: 'b', scrollLeft: 50 },
    ];
    expect(matchTableScroll(prior, ['c', 'a', 'b'])).toEqual([undefined, 100, 50]);
  });

  it('restores correctly when a table is removed or the tables are reordered', () => {
    const prior = [
      { key: 'a', scrollLeft: 100 },
      { key: 'b', scrollLeft: 50 },
    ];
    expect(matchTableScroll(prior, ['b'])).toEqual([50]); // "a" removed
    expect(matchTableScroll(prior, ['b', 'a'])).toEqual([50, 100]); // reordered
  });

  it('gives two identical tables their own offsets, in order', () => {
    const prior = [
      { key: 'dup', scrollLeft: 10 },
      { key: 'dup', scrollLeft: 20 },
    ];
    expect(matchTableScroll(prior, ['dup', 'dup'])).toEqual([10, 20]);
    expect(matchTableScroll(prior, ['dup'])).toEqual([10]);
  });

  it('leaves new tables unrestored when there is no prior capture', () => {
    expect(matchTableScroll([], ['a', 'b'])).toEqual([undefined, undefined]);
  });
});

describe('computeTableOverflow', () => {
  it('reports no overflow when content fits, with 1px slack for rounding', () => {
    expect(computeTableOverflow(500, 500, 0)).toEqual({
      overflowing: false,
      overflowStart: false,
      overflowEnd: false,
    });
    // max === 1 is within slack (not > 1), so still not overflowing.
    expect(computeTableOverflow(501, 500, 0)).toEqual({
      overflowing: false,
      overflowStart: false,
      overflowEnd: false,
    });
  });

  it('fades only the end edge when scrolled to the far left', () => {
    // scrollWidth 800, clientWidth 500 → max 300; scrollLeft 0.
    expect(computeTableOverflow(800, 500, 0)).toEqual({
      overflowing: true,
      overflowStart: false,
      overflowEnd: true,
    });
  });

  it('fades only the start edge when scrolled to the far right', () => {
    expect(computeTableOverflow(800, 500, 300)).toEqual({
      overflowing: true,
      overflowStart: true,
      overflowEnd: false,
    });
  });

  it('fades both edges when scrolled to the middle', () => {
    expect(computeTableOverflow(800, 500, 150)).toEqual({
      overflowing: true,
      overflowStart: true,
      overflowEnd: true,
    });
  });

  it('applies the 1px slack to the start/end edges, not just the overflow flag', () => {
    // max = 800 - 500 = 300. Start fade needs scrollLeft > 1; end fade needs
    // scrollLeft < max - 1 (299). At the exact 1px boundaries neither edge
    // fades, so a sub-pixel rest position doesn't flicker a cue.
    expect(computeTableOverflow(800, 500, 1)).toMatchObject({ overflowStart: false });
    expect(computeTableOverflow(800, 500, 2)).toMatchObject({ overflowStart: true });
    expect(computeTableOverflow(800, 500, 299)).toMatchObject({ overflowEnd: false });
    expect(computeTableOverflow(800, 500, 298)).toMatchObject({ overflowEnd: true });
  });

  it('never reports overflow when the viewport is wider than its content', () => {
    // Negative max (clientWidth > scrollWidth) must not spuriously fade.
    expect(computeTableOverflow(400, 500, 0)).toEqual({
      overflowing: false,
      overflowStart: false,
      overflowEnd: false,
    });
  });
});

describe('isInsideSvgTextContent', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  it('returns true for text nodes inside an SVG <text> element', () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const textEl = document.createElementNS(SVG_NS, 'text');
    const tn = document.createTextNode('POST /auth/login');
    textEl.appendChild(tn);
    svg.appendChild(textEl);
    document.body.appendChild(svg);
    expect(isInsideSvgTextContent(tn)).toBe(true);
    svg.remove();
  });

  it('returns true for text nodes inside an SVG <tspan>', () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const textEl = document.createElementNS(SVG_NS, 'text');
    const tspan = document.createElementNS(SVG_NS, 'tspan');
    const tn = document.createTextNode('auth');
    tspan.appendChild(tn);
    textEl.appendChild(tspan);
    svg.appendChild(textEl);
    document.body.appendChild(svg);
    expect(isInsideSvgTextContent(tn)).toBe(true);
    svg.remove();
  });

  it('returns false for HTML text nodes inside an SVG <foreignObject>', () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    const div = document.createElement('div');
    const span = document.createElement('span');
    span.className = 'nodeLabel';
    const tn = document.createTextNode('auth');
    span.appendChild(tn);
    div.appendChild(span);
    fo.appendChild(div);
    svg.appendChild(fo);
    document.body.appendChild(svg);
    expect(isInsideSvgTextContent(tn)).toBe(false);
    svg.remove();
  });

  it('returns false for plain HTML text nodes', () => {
    const p = document.createElement('p');
    const tn = document.createTextNode('auth in prose');
    p.appendChild(tn);
    document.body.appendChild(p);
    expect(isInsideSvgTextContent(tn)).toBe(false);
    p.remove();
  });
});

describe('MarkdownViewer comment highlights — markdown-formatted anchor fallback', () => {
  it('highlights a comment anchor that uses markdown bold formatting', async () => {
    // The agent wrote the anchor as "**Hello world**" but the DOM renders it as
    // plain text "Hello world" inside a <strong> element. wrapText must strip
    // the markdown formatting and still find the match.
    const markdown = '# Doc\n\n**Hello world** is the greeting.\n';
    const html = renderMarkdown(markdown);

    const comment = {
      id: 'cmt_bold',
      anchor: '**Hello world**',
      text: 'Nice greeting',
      author: 'Claude',
      timestamp: new Date().toISOString(),
      cleanOffset: 0,
    };

    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[comment]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      const mark = container.querySelector('mark.comment-highlight');
      expect(mark).not.toBeNull();
      expect(mark?.textContent).toBe('Hello world');
    });
  });
});

describe('MarkdownViewer comment highlights — frontmatter fields', () => {
  it('paints a highlight on a frontmatter value, from a marker parsed out of the file', async () => {
    // End to end for the frontmatter feature: insertComment relocates the
    // marker past the closing fence, parseComments reads it back, and the
    // highlight has to land on the rendered field rather than nowhere.
    const source =
      '---\nname: mcp2cli\ndescription: Use when a server should be driven from the shell\n---\n\n# Overview\n\nBody text.\n';
    const raw = insertComment(
      source,
      'Use when a server should be driven from the shell',
      'too vague?',
    );
    const { comments, cleanMarkdown } = parseComments(raw);
    expect(comments).toHaveLength(1);
    expect(cleanMarkdown).toBe(source);

    const { container } = render(
      <MarkdownViewer
        html={renderMarkdown(cleanMarkdown)}
        cleanMarkdown={cleanMarkdown}
        comments={comments}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      const mark = container.querySelector('mark.comment-highlight');
      expect(mark).not.toBeNull();
      expect(mark?.textContent).toBe('Use when a server should be driven from the shell');
      expect(mark?.closest('.doc-frontmatter')).not.toBeNull();
    });
  });
});

describe('MarkdownViewer comment highlights — comments that relocate to a shared offset', () => {
  it('keeps two comments on repeated text inside one code fence on separate highlights', async () => {
    // insertComment pushes both markers to the opening fence line, so both
    // comments carry the same cleanOffset. Grouping on offset + anchor alone
    // merged them into one <mark> on the first occurrence.
    const doc = '# Config\n\n```yaml\ndraft: false\narchived: false\n```\n\nBody.\n';
    let raw = insertComment(doc, 'false', 'first', 'User', 'draft: ', '\narchived');
    raw = insertComment(raw, 'false', 'second', 'User', 'archived: ', '\n```');
    const { comments, cleanMarkdown } = parseComments(raw);
    expect(comments).toHaveLength(2);
    expect(comments[0].cleanOffset).toBe(comments[1].cleanOffset);

    const { container } = render(
      <MarkdownViewer
        html={renderMarkdown(cleanMarkdown)}
        cleanMarkdown={cleanMarkdown}
        comments={comments}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      const marks = Array.from(container.querySelectorAll('mark'));
      expect(marks).toHaveLength(2);
      // One id per mark: neither comment rides along on the other's highlight.
      for (const mark of marks) {
        expect((mark as HTMLElement).dataset.commentIds?.split(',')).toHaveLength(1);
      }
    });
  });

  it('still merges two comments that genuinely share one anchor occurrence', async () => {
    // Same offset, same anchor, same context: one highlight carrying both ids.
    const doc = '# Doc\n\nThe quick brown fox.\n';
    let raw = insertComment(doc, 'quick', 'first', 'User');
    raw = insertComment(raw, 'quick', 'second', 'User');
    const { comments, cleanMarkdown } = parseComments(raw);

    const { container } = render(
      <MarkdownViewer
        html={renderMarkdown(cleanMarkdown)}
        cleanMarkdown={cleanMarkdown}
        comments={comments}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      const marks = Array.from(container.querySelectorAll('mark'));
      expect(marks).toHaveLength(1);
      expect((marks[0] as HTMLElement).dataset.commentIds?.split(',')).toHaveLength(2);
    });
  });
});

describe('MarkdownViewer comment highlights — numbered heading anchors', () => {
  it('highlights a multi-block anchor whose heading opens with a list-like number', async () => {
    // stripInlineFormatting reads "1. " at a line start as an ordered-list
    // marker, so the stripped variant of this anchor loses it and matches
    // nothing. findMatchRange must fall through to the flexible search on the
    // original text rather than giving up, or the anchor is reported lost.
    const markdown = '## 1. Current Strategy\n\n### 1.1 The thesis\n\nOwn the lead journey.\n';
    // Block tags butt against each other, as they do once the viewer has
    // re-rendered: the concatenated text nodes carry no separator, so the
    // anchor's newlines cannot match literally and the tiered search runs.
    const html = '<h2>1. Current Strategy</h2><h3>1.1 The thesis</h3><p>Own the lead journey.</p>';

    const comment = {
      id: 'cmt_numbered',
      anchor: '1. Current Strategy\n1.1 The thesis\nOwn the lead journey.',
      text: 'Section note',
      author: 'Dennis',
      timestamp: new Date().toISOString(),
      cleanOffset: 0,
    };

    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[comment]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      const marks = container.querySelectorAll('mark.comment-highlight');
      expect(marks.length).toBeGreaterThan(0);
      expect(marks[0].textContent).toContain('1. Current Strategy');
    });
  });
});

describe('MarkdownViewer comment highlights — mermaid-node anchor fallback', () => {
  it('highlights a Mermaid label even when the anchor includes markdown formatting inside the brackets', async () => {
    // Covers the deepest fallback branch in findMatchRange: Mermaid node
    // syntax where the inner label itself carries markdown markup the SVG
    // strips out (e.g. "E[**Important** Step]" renders as "Important Step").
    const markdown = [
      '# Doc',
      '',
      '```mermaid',
      'flowchart LR',
      '  E[Important Step]',
      '  F[Done]',
      '  E --> F',
      '```',
    ].join('\n');
    const html = renderMarkdown(markdown);

    const comment = {
      id: 'cmt_mermaid_stripped',
      anchor: 'E[**Important** Step]',
      text: 'Drop the emphasis',
      author: 'Claude',
      timestamp: new Date().toISOString(),
      cleanOffset: 0,
    };

    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[comment]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      const htmlMark = container.querySelector(
        'mark.comment-highlight, mark.comment-highlight-sent',
      );
      const svgMark = container.querySelector('.mermaid-comment-highlight');
      expect(htmlMark ?? svgMark).not.toBeNull();
    });
  });

  it('highlights a comment anchor written in Mermaid node syntax by extracting the inner label', async () => {
    // The agent wrote the anchor as "E[Clicks Discover Pages]" (Mermaid source syntax).
    // The rendered SVG only contains the inner label text; wrapText must extract it
    // and still place a highlight.
    const markdown = [
      '# Doc',
      '',
      '```mermaid',
      'flowchart LR',
      '  E[Clicks Discover Pages]',
      '  F[Loads results]',
      '  E --> F',
      '```',
    ].join('\n');
    const html = renderMarkdown(markdown);

    const comment = {
      id: 'cmt_mermaid',
      anchor: 'E[Clicks Discover Pages]',
      text: 'Label is too long',
      author: 'Claude',
      timestamp: new Date().toISOString(),
      cleanOffset: 0,
    };

    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[comment]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      // The mark may land on either an HTML <mark> (foreignObject) or a mermaid SVG
      // text element. Either way, the rendered label text must appear highlighted.
      const htmlMark = container.querySelector(
        'mark.comment-highlight, mark.comment-highlight-sent',
      );
      const svgMark = container.querySelector('.mermaid-comment-highlight');
      // At least one highlight form must be present.
      expect(htmlMark ?? svgMark).not.toBeNull();
      if (htmlMark) {
        expect(htmlMark.textContent).toContain('Clicks Discover Pages');
      }
    });
  });
});

describe('MarkdownViewer selection highlights', () => {
  it('does not leave behind an empty inline code element when selection starts with inline code', async () => {
    const markdown =
      '# PRD: md-redline\n\n## Summary\n\n`md-redline` is a local-first markdown review app built for workflows where humans and AI agents collaborate directly through `.md` files.';

    const html = renderMarkdown(markdown);

    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[]}
        activeCommentId={null}
        selectionText={'md-redline is a local-first markdown review app built'}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('mark.selection-highlight')).not.toBeNull();
    });

    const paragraph = Array.from(container.querySelectorAll('.prose p')).find((el) =>
      el.textContent?.includes('local-first markdown review app'),
    );

    expect(paragraph).not.toBeNull();
    expect(paragraph?.innerHTML).not.toContain('<code></code>');

    const leadingCode = paragraph?.querySelector('mark.selection-highlight > code');
    expect(leadingCode?.textContent).toBe('md-redline');
  });
});

describe('MarkdownViewer comment highlights — resolved anchors', () => {
  const markdown = '# Doc\n\nThe timing question is two questions being conflated here.\n';
  const html = renderMarkdown(markdown);

  const base = {
    anchor: 'two questions',
    text: 'Worth splitting?',
    author: 'Dennis',
    timestamp: new Date().toISOString(),
  };

  function renderWith(comments: Parameters<typeof MarkdownViewer>[0]['comments'], resolve = true) {
    return render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={comments}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        enableResolve={resolve}
        onHighlightClick={vi.fn()}
      />,
    );
  }

  it('paints a resolved anchor as a trace rather than dropping it', async () => {
    // Resolved anchors used to be skipped entirely, which left no sign that a
    // passage had ever been discussed.
    const { container } = renderWith([{ ...base, id: 'c1', status: 'resolved' as const }]);

    await waitFor(() => {
      const mark = container.querySelector('mark.comment-highlight-resolved');
      expect(mark).not.toBeNull();
      expect(mark?.textContent).toBe('two questions');
      expect((mark as HTMLElement).dataset.commentIds).toBe('c1');
    });
    expect(container.querySelector('mark.comment-highlight')).toBeNull();
  });

  it('keeps the full highlight when one comment on the anchor is still open', async () => {
    // Same anchor and offset puts both comments in one highlight group, and
    // that group paints one mark. The passage still has something live on it,
    // so the open treatment has to win.
    //
    // The resolved id stays OUT of that mark. Consumers read this list as the
    // comments the mark answers for: the click handler and context menu take
    // the first, drag-resize rewrites the anchor of every one, and the density
    // strip emits a tick per one. A settled id riding along in a mark that
    // paints as live reaches all three, and the drag one writes to the file.
    const { container } = renderWith([
      { ...base, id: 'c1', status: 'resolved' as const },
      { ...base, id: 'c2' },
    ]);

    await waitFor(() => {
      const mark = container.querySelector('mark.comment-highlight');
      expect(mark).not.toBeNull();
      expect((mark as HTMLElement).dataset.commentIds).toBe('c2');
    });
    expect(container.querySelector('mark.comment-highlight-resolved')).toBeNull();
  });

  it('clicking a mixed group activates the open comment, not the resolved one', async () => {
    // The mark paints as open, and the rail is holding the open comment's card.
    // Handing the click to the resolved id would open the settled thread in a
    // popover while the card the user is looking at stays untouched.
    const onHighlightClick = vi.fn();
    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[
          { ...base, id: 'c1', status: 'resolved' as const },
          { ...base, id: 'c2' },
        ]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        enableResolve
        onHighlightClick={onHighlightClick}
      />,
    );

    const mark = await waitFor(() => {
      const el = container.querySelector('mark.comment-highlight');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    fireEvent.click(mark);
    expect(onHighlightClick).toHaveBeenCalledWith('c2');
  });

  it('does not light a mixed group when the resolved member is the active one', async () => {
    // The active styles are the open ones here, and getActiveMarks feeds
    // drag-resize off `.comment-highlight-active`. Letting a settled comment
    // switch them on puts the full fill on the passage and hands out anchor
    // handles for a thread that cannot even be edited.
    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[
          { ...base, id: 'c1', status: 'resolved' as const },
          { ...base, id: 'c2' },
        ]}
        activeCommentId="c1"
        selectionText={null}
        selectionOffset={null}
        enableResolve
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('mark.comment-highlight')).not.toBeNull();
    });
    expect(container.querySelector('mark.comment-highlight-active')).toBeNull();
    expect(container.querySelector('mark.comment-highlight-resolved-active')).toBeNull();
  });

  it('treats resolved as open when the resolve feature is off', async () => {
    const { container } = renderWith([{ ...base, id: 'c1', status: 'resolved' as const }], false);

    await waitFor(() => {
      expect(container.querySelector('mark.comment-highlight')).not.toBeNull();
    });
    expect(container.querySelector('mark.comment-highlight-resolved')).toBeNull();
  });

  it('marks the active resolved trace without giving it the open active fill', async () => {
    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[{ ...base, id: 'c1', status: 'resolved' as const }]}
        activeCommentId="c1"
        selectionText={null}
        selectionOffset={null}
        enableResolve
        onHighlightClick={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('mark.comment-highlight-resolved-active')).not.toBeNull();
    });
    expect(container.querySelector('mark.comment-highlight-active')).toBeNull();
  });
});

describe('MarkdownViewer comment highlights — overlapping resolved and open anchors', () => {
  // Anchors that OVERLAP without matching land in different highlight groups,
  // so the mixed-group rules above never see them. wrapText walks into marks
  // that are already painted, so the shorter anchor nests inside the longer
  // one and `closest` hands a click on the shared words to the inner mark.
  const markdown = '# Doc\n\nThe system blocks brute force attacks reliably.\n';
  const html = renderMarkdown(markdown);

  const base = {
    text: 'Worth a look',
    author: 'Dennis',
    timestamp: new Date().toISOString(),
  };

  function renderOverlapping(onHighlightClick: () => void) {
    return render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[
          { ...base, id: 'open-1', anchor: 'brute force attacks' },
          { ...base, id: 'settled-1', anchor: 'brute force', status: 'resolved' as const },
        ]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        enableResolve
        onHighlightClick={onHighlightClick}
      />,
    );
  }

  it('nests the trace inside the live highlight', async () => {
    const { container } = renderOverlapping(vi.fn());

    // Pins the premise the click test below depends on. If painting ever
    // stops nesting these, that test would pass for the wrong reason.
    const trace = await waitFor(() => {
      const el = container.querySelector('mark.comment-highlight-resolved');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(trace.closest('mark.comment-highlight')).not.toBeNull();
  });

  it('gives a click on the overlap to the open comment, not the settled one', async () => {
    const onHighlightClick = vi.fn();
    const { container } = renderOverlapping(onHighlightClick);

    const trace = await waitFor(() => {
      const el = container.querySelector('mark.comment-highlight-resolved');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    // A click that lands squarely on the trace: the innermost mark is the
    // settled thread, and taking it would open a resolved comment while the
    // live one's card sits untouched in the rail.
    fireEvent.click(trace);
    expect(onHighlightClick).toHaveBeenCalledWith('open-1');
  });

  it('still opens a trace that no live highlight encloses', async () => {
    // The preference is for an OPEN ancestor, not against traces: a trace
    // standing on its own is the only thing on that passage and stays
    // clickable.
    const onHighlightClick = vi.fn();
    const { container } = render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[
          { ...base, id: 'open-1', anchor: 'The system blocks' },
          { ...base, id: 'settled-1', anchor: 'reliably', status: 'resolved' as const },
        ]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        enableResolve
        onHighlightClick={onHighlightClick}
      />,
    );

    const trace = await waitFor(() => {
      const el = container.querySelector('mark.comment-highlight-resolved');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    fireEvent.click(trace);
    expect(onHighlightClick).toHaveBeenCalledWith('settled-1');
  });
});
