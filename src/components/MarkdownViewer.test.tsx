// @vitest-environment jsdom

import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  MarkdownViewer,
  isInsideSvgTextContent,
  computeTableOverflow,
  matchTableScroll,
  wrapText,
} from './MarkdownViewer';
import { renderMarkdown } from '../markdown/pipeline';
import { insertComment, parseComments } from '../lib/comment-parser';
import { getVisibleTextOffset } from '../lib/visible-text';
import type { MdComment } from '../types';

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

describe('wrapText return value', () => {
  // The unpainted-anchor report (#99) hinges on this: the highlight pass
  // reads wrapText's return value to tell a real miss (the text is not in the
  // render) apart from a mark it successfully painted, so every "no match"
  // path has to report false and every path that actually marks something,
  // false or not, has to report true.
  it('returns true and wraps a <mark> when the text is found', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>Hello world</p>';
    const result = wrapText(container, 'world', (mark) => {
      mark.className = 'comment-highlight';
    });
    expect(result).toBe(true);
    expect(container.querySelector('mark.comment-highlight')?.textContent).toBe('world');
  });

  it('returns false when the text has no match anywhere in the container', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>Hello world</p>';
    const result = wrapText(container, 'a phrase that is not in the document', () => {});
    expect(result).toBe(false);
    expect(container.querySelector('mark')).toBeNull();
  });

  it('returns false for a container with no text nodes at all', () => {
    const container = document.createElement('div');
    const result = wrapText(container, 'anything', () => {});
    expect(result).toBe(false);
  });

  it('returns true when the match lands in an SVG <text> label, even though no HTML <mark> is created', () => {
    const container = document.createElement('div');
    container.innerHTML =
      '<div class="mermaid-block"><svg><text>POST /auth/login</text></svg></div>';
    const onSvgText = vi.fn();
    const result = wrapText(
      container,
      'auth',
      () => {},
      undefined,
      undefined,
      undefined,
      onSvgText,
    );
    expect(result).toBe(true);
    expect(onSvgText).toHaveBeenCalledTimes(1);
    // SVG <text> cannot hold an HTML <mark> child, so the redirect to
    // onSvgText must be the only thing that happened.
    expect(container.querySelector('mark')).toBeNull();
  });
});

describe('MarkdownViewer onHighlightsPainted: unpainted anchors (#99)', () => {
  it('reports the id of an open comment whose anchor is in the file but not the render', async () => {
    // renderMarkdown defaults renderHtmlComments to false, so the HTML
    // comment's body never reaches the DOM: exactly the render gap #99 is
    // about. The anchor is still real text in cleanMarkdown, so
    // detectMissingAnchors would not flag it either; only the paint pass
    // itself knows this one failed to find a home.
    const markdown = '# Notes\n\n<!-- todo: fix this later -->\n\nBody text.\n';
    const html = renderMarkdown(markdown);
    const comment: MdComment = {
      id: 'c-hidden',
      anchor: 'todo: fix this later',
      text: 'flag before merging',
      author: 'Agent',
      timestamp: new Date().toISOString(),
    };
    const onHighlightsPainted = vi.fn();

    render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[comment]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
        onHighlightsPainted={onHighlightsPainted}
      />,
    );

    await waitFor(() => expect(onHighlightsPainted).toHaveBeenCalled());
    const reported = onHighlightsPainted.mock.calls.at(-1)?.[0] as Set<string> | null;
    expect(reported).not.toBeNull();
    expect(reported?.has('c-hidden')).toBe(true);
  });

  it('reports an empty (non-null) set once every anchor paints', async () => {
    const markdown = '# Notes\n\nHello world.\n';
    const html = renderMarkdown(markdown);
    const comment: MdComment = {
      id: 'c-ok',
      anchor: 'Hello world',
      text: 'nice',
      author: 'Agent',
      timestamp: new Date().toISOString(),
    };
    const onHighlightsPainted = vi.fn();

    render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[comment]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
        onHighlightsPainted={onHighlightsPainted}
      />,
    );

    await waitFor(() => expect(onHighlightsPainted).toHaveBeenCalled());
    const reported = onHighlightsPainted.mock.calls.at(-1)?.[0] as Set<string> | null;
    expect(reported).not.toBeNull();
    expect(reported?.size).toBe(0);
  });

  it('does not report a resolved-only group, even when its anchor fails to paint', async () => {
    // Only OPEN comments count: a resolved-only group paints no mark and
    // therefore has no margin card to withhold in the first place.
    const markdown = '# Notes\n\n<!-- todo: fix this later -->\n\nBody text.\n';
    const html = renderMarkdown(markdown);
    const comment: MdComment = {
      id: 'c-resolved-hidden',
      anchor: 'todo: fix this later',
      text: 'already handled',
      author: 'Agent',
      timestamp: new Date().toISOString(),
      status: 'resolved',
    };
    const onHighlightsPainted = vi.fn();

    render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[comment]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
        onHighlightsPainted={onHighlightsPainted}
        enableResolve
      />,
    );

    await waitFor(() => expect(onHighlightsPainted).toHaveBeenCalled());
    const reported = onHighlightsPainted.mock.calls.at(-1)?.[0] as Set<string> | null;
    expect(reported?.has('c-resolved-hidden')).toBe(false);
  });

  it('reports null (not authoritative) while a Mermaid diagram in the document has not rendered yet', async () => {
    // No SVG for the block yet means no label text to match against, so any
    // report this pass makes would be a guess. mermaidSvgMap is passed as an
    // empty Map so the diagram source has no entry, matching the "still
    // loading" branch in the highlight effect's Mermaid pass.
    const markdown = '# Notes\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nSome paragraph.\n';
    const html = renderMarkdown(markdown);
    const onHighlightsPainted = vi.fn();

    render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
        onHighlightsPainted={onHighlightsPainted}
        mermaidSvgMap={new Map()}
      />,
    );

    await waitFor(() => expect(onHighlightsPainted).toHaveBeenCalled());
    expect(onHighlightsPainted).toHaveBeenLastCalledWith(null);
  });

  it('still reports authoritatively when a fence useMermaidRenderer will never extract has no SVG (#99 follow-up)', async () => {
    // A ```mermaid fence indented inside a blockquote never matches
    // extractMermaidSources's ^-anchored regex (the fence marker is not at
    // column 0), so mermaidSvgMap will never get an entry for it no matter
    // how long the pass waits. It still becomes a <pre><code
    // class="language-mermaid"> in the DOM, so MarkdownViewer's mermaid loop
    // sees it and must not mistake "no entry" for "still loading" here: that
    // would freeze every report at null forever, hiding an unrelated
    // unpainted anchor (the dropped HTML comment below) permanently.
    const markdown = [
      '# Notes',
      '',
      '> ```mermaid',
      '> flowchart TD',
      '>   A --> B',
      '> ```',
      '',
      '<!-- todo: fix this later -->',
      '',
      'Body text.',
    ].join('\n');
    const html = renderMarkdown(markdown);
    const comment: MdComment = {
      id: 'c-unrelated-hidden',
      anchor: 'todo: fix this later',
      text: 'flag before merging',
      author: 'Agent',
      timestamp: new Date().toISOString(),
    };
    const onHighlightsPainted = vi.fn();

    render(
      <MarkdownViewer
        html={html}
        cleanMarkdown={markdown}
        comments={[comment]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
        onHighlightsPainted={onHighlightsPainted}
        mermaidSvgMap={new Map()}
      />,
    );

    await waitFor(() => expect(onHighlightsPainted).toHaveBeenCalled());
    const reported = onHighlightsPainted.mock.calls.at(-1)?.[0] as Set<string> | null;
    expect(reported).not.toBeNull();
    expect(reported?.has('c-unrelated-hidden')).toBe(true);
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

  it('paints the occurrence at the selection offset, not a copy just before it', async () => {
    // Table cells run together in the rendered text, so a row ending in
    // "knowledge source" puts a second "source" a few characters before the
    // bold one that starts the next row.
    const markdown =
      '| Say this | Engineering calls it |\n| --- | --- |\n| **library** | knowledge source |\n| **source** (one connected channel) | connector |\n';
    const props = {
      html: renderMarkdown(markdown),
      cleanMarkdown: markdown,
      comments: [],
      activeCommentId: null,
      onHighlightClick: vi.fn(),
    };

    // jsdom has no ResizeObserver, and the viewer observes every table for
    // its scroll cues.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      const { container, rerender } = render(
        <MarkdownViewer {...props} selectionText={null} selectionOffset={null} />,
      );
      const prose = container.querySelector('.prose') as HTMLElement;
      const target = Array.from(prose.querySelectorAll('td strong')).find(
        (el) => el.textContent === 'source',
      );
      // The offset the selection resolver reports for a double-click on it.
      const offset = getVisibleTextOffset(prose, target!.firstChild!, 0);

      rerender(<MarkdownViewer {...props} selectionText="source" selectionOffset={offset} />);

      await waitFor(() => {
        expect(container.querySelector('mark.selection-highlight')).not.toBeNull();
      });
      const row = container.querySelector('mark.selection-highlight')?.closest('tr');
      expect(row?.querySelector('td')?.textContent).toBe('source (one connected channel)');
    } finally {
      vi.unstubAllGlobals();
    }
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

describe('MarkdownViewer viewport scroll anchor', () => {
  // jsdom does no layout — every element's getBoundingClientRect() is a zero
  // rect — so these DOM-level tests fake a simple vertical stack: each direct
  // child of the `.prose` container occupies a fixed-height slot in document
  // order, and its viewport-relative rect is computed from that slot minus
  // the scroller's live scrollTop, exactly as a real browser would report it
  // as scrollTop changes. Installed as an Element.prototype override (rather
  // than patched onto individual nodes) because the rebuild the effect does
  // replaces every node — a per-instance patch on the "before" elements
  // wouldn't reach the "after" ones the restore step measures.
  const ELEMENT_HEIGHT = 50;
  const VIEWPORT_HEIGHT = 500;

  function fakeRect(top: number, bottom: number): DOMRect {
    return {
      top,
      bottom,
      left: 0,
      right: 100,
      width: 100,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON() {
        return this;
      },
    } as DOMRect;
  }

  function installFakeLayout(prose: HTMLElement, scroller: HTMLElement): () => void {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this === scroller) return fakeRect(0, VIEWPORT_HEIGHT);
      if (this.parentElement === prose) {
        const idx = Array.from(prose.children).indexOf(this);
        const top = idx * ELEMENT_HEIGHT - scroller.scrollTop;
        return fakeRect(top, top + ELEMENT_HEIGHT);
      }
      return original.call(this);
    };
    return () => {
      Element.prototype.getBoundingClientRect = original;
    };
  }

  // Eight top-level blocks: a title, five filler paragraphs, the reader's
  // anchor heading, and one paragraph after it — each with unique text so
  // viewportAnchorKey can't collide two of them by accident.
  const baseMarkdown = [
    '# Doc Title',
    '',
    'Paragraph one with unique text alpha.',
    '',
    'Paragraph two with unique text bravo.',
    '',
    'Paragraph three with unique text charlie.',
    '',
    'Paragraph four with unique text delta.',
    '',
    'Paragraph five with unique text echo.',
    '',
    '## Target Heading',
    '',
    'Paragraph after target with unique text foxtrot.',
  ].join('\n');

  // Three new paragraphs prepended above everything: an edit above the reader.
  const insertedAbove = [
    'Inserted paragraph one unique text zulu.',
    '',
    'Inserted paragraph two unique text yankee.',
    '',
    'Inserted paragraph three unique text xray.',
  ].join('\n');

  function renderViewer(markdown: string, enableResolve?: boolean) {
    const html = renderMarkdown(markdown);
    return render(
      <div className="overflow-y-auto" style={{ height: `${VIEWPORT_HEIGHT}px` }}>
        <MarkdownViewer
          html={html}
          cleanMarkdown={markdown}
          comments={[]}
          activeCommentId={null}
          selectionText={null}
          selectionOffset={null}
          enableResolve={enableResolve}
          onHighlightClick={vi.fn()}
        />
      </div>,
    );
  }

  function findByText(root: HTMLElement, text: string): HTMLElement {
    const el = Array.from(root.children).find((c) => c.textContent?.includes(text));
    expect(el).toBeDefined();
    return el as HTMLElement;
  }

  it('preserves the reader viewport position when content is inserted above it', () => {
    const { container, rerender } = renderViewer(baseMarkdown);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const prose = container.querySelector('.prose') as HTMLElement;
    expect(scroller).not.toBeNull();
    expect(prose).not.toBeNull();
    // jsdom implements no Element.scrollTo.
    scroller.scrollTo = ((options: ScrollToOptions) => {
      scroller.scrollTop = options.top ?? scroller.scrollTop;
    }) as typeof scroller.scrollTo;

    const restoreLayout = installFakeLayout(prose, scroller);
    try {
      scroller.scrollTop = 300;

      const targetBefore = findByText(prose, 'Target Heading');
      const scrollerRect = scroller.getBoundingClientRect();
      const offsetBefore = targetBefore.getBoundingClientRect().top - scrollerRect.top;

      const updatedMarkdown = `${insertedAbove}\n\n${baseMarkdown}`;
      const updatedHtml = renderMarkdown(updatedMarkdown);

      rerender(
        <div className="overflow-y-auto" style={{ height: `${VIEWPORT_HEIGHT}px` }}>
          <MarkdownViewer
            html={updatedHtml}
            cleanMarkdown={updatedMarkdown}
            comments={[]}
            activeCommentId={null}
            selectionText={null}
            selectionOffset={null}
            onHighlightClick={vi.fn()}
          />
        </div>,
      );

      const targetAfter = findByText(prose, 'Target Heading');
      // The innerHTML rebuild replaces every node, so native scroll anchoring
      // has no node to hold the reader's place with.
      expect(targetAfter).not.toBe(targetBefore);

      const offsetAfter =
        targetAfter.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

      // Without the fix, offsetAfter would be ~150px lower (3 inserted
      // paragraphs x 50px) because scrollTop never moved to compensate.
      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThanOrEqual(2);
    } finally {
      restoreLayout();
    }
  });

  it('leaves scroll position untouched when a re-render changes nothing', () => {
    const { container, rerender } = renderViewer(baseMarkdown);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const prose = container.querySelector('.prose') as HTMLElement;

    const restoreLayout = installFakeLayout(prose, scroller);
    try {
      scroller.scrollTop = 300;

      // Force the highlight effect to re-run (enableResolve is a dep)
      // without changing the rendered markdown at all.
      rerender(
        <div className="overflow-y-auto" style={{ height: `${VIEWPORT_HEIGHT}px` }}>
          <MarkdownViewer
            html={renderMarkdown(baseMarkdown)}
            cleanMarkdown={baseMarkdown}
            comments={[]}
            activeCommentId={null}
            selectionText={null}
            selectionOffset={null}
            enableResolve
            onHighlightClick={vi.fn()}
          />
        </div>,
      );

      expect(scroller.scrollTop).toBeCloseTo(300, 0);
    } finally {
      restoreLayout();
    }
  });

  it('corrects the position without animating', () => {
    const { container, rerender } = renderViewer(baseMarkdown);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const prose = container.querySelector('.prose') as HTMLElement;

    // The scroller has `scroll-behavior: smooth` (index.css), which jsdom
    // ignores. Model it: a scroll that does not opt out starts an animation,
    // so nothing has moved on the tick that asked for it. A correction by
    // plain scrollTop assignment or a smooth scrollTo fails here the way it
    // animates in the browser.
    let top = 0;
    const behaviors: (ScrollBehavior | undefined)[] = [];
    const readerScrollsTo = (v: number) => {
      top = v;
    };
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: () => {},
    });
    scroller.scrollTo = ((options: ScrollToOptions) => {
      behaviors.push(options.behavior);
      if (options.behavior === 'instant') top = options.top ?? top;
    }) as typeof scroller.scrollTo;

    const restoreLayout = installFakeLayout(prose, scroller);
    try {
      readerScrollsTo(300);
      const offsetBefore =
        findByText(prose, 'Target Heading').getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;

      const updatedMarkdown = `${insertedAbove}\n\n${baseMarkdown}`;
      rerender(
        <div className="overflow-y-auto" style={{ height: `${VIEWPORT_HEIGHT}px` }}>
          <MarkdownViewer
            html={renderMarkdown(updatedMarkdown)}
            cleanMarkdown={updatedMarkdown}
            comments={[]}
            activeCommentId={null}
            selectionText={null}
            selectionOffset={null}
            onHighlightClick={vi.fn()}
          />
        </div>,
      );

      const offsetAfter =
        findByText(prose, 'Target Heading').getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;
      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThanOrEqual(2);
      expect(behaviors).toEqual(['instant']);
    } finally {
      restoreLayout();
    }
  });

  // Stands in for Element.scrollTo, which jsdom does not implement.
  function stubScrollTo(scroller: HTMLElement) {
    scroller.scrollTo = ((options: ScrollToOptions) => {
      scroller.scrollTop = options.top ?? scroller.scrollTop;
    }) as typeof scroller.scrollTo;
  }

  it('keeps the reader on the same copy of a repeated block', () => {
    // Nine blocks; the two horizontal rules share a key. With 50px blocks and
    // scrollTop 300 the second rule (index 6) is at the top of the viewport.
    const markdown = [
      '# Doc Title',
      '',
      'Paragraph one unique alpha.',
      '',
      '---',
      '',
      'Paragraph two unique bravo.',
      '',
      'Paragraph three unique charlie.',
      '',
      'Paragraph four unique delta.',
      '',
      '---',
      '',
      'Paragraph five unique echo.',
      '',
      'Paragraph six unique foxtrot.',
    ].join('\n');
    const { container, rerender } = renderViewer(markdown);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const prose = container.querySelector('.prose') as HTMLElement;
    stubScrollTo(scroller);

    const restoreLayout = installFakeLayout(prose, scroller);
    try {
      scroller.scrollTop = 300;
      expect(prose.children[6].tagName).toBe('HR');

      // Three paragraphs inserted above both rules: the second rule moves to
      // index 9, and the first one (now at 5) is the wrong copy to land on.
      const updatedMarkdown = `${insertedAbove}\n\n${markdown}`;
      rerender(
        <div className="overflow-y-auto" style={{ height: `${VIEWPORT_HEIGHT}px` }}>
          <MarkdownViewer
            html={renderMarkdown(updatedMarkdown)}
            cleanMarkdown={updatedMarkdown}
            comments={[]}
            activeCommentId={null}
            selectionText={null}
            selectionOffset={null}
            onHighlightClick={vi.fn()}
          />
        </div>,
      );

      expect(prose.children[9].tagName).toBe('HR');
      expect(scroller.scrollTop).toBe(450);
    } finally {
      restoreLayout();
    }
  });

  it('leaves a reader at the very top there when content is inserted above', () => {
    const { container, rerender } = renderViewer(baseMarkdown);
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const prose = container.querySelector('.prose') as HTMLElement;
    stubScrollTo(scroller);

    const restoreLayout = installFakeLayout(prose, scroller);
    try {
      expect(scroller.scrollTop).toBe(0);

      const updatedMarkdown = `${insertedAbove}\n\n${baseMarkdown}`;
      rerender(
        <div className="overflow-y-auto" style={{ height: `${VIEWPORT_HEIGHT}px` }}>
          <MarkdownViewer
            html={renderMarkdown(updatedMarkdown)}
            cleanMarkdown={updatedMarkdown}
            comments={[]}
            activeCommentId={null}
            selectionText={null}
            selectionOffset={null}
            onHighlightClick={vi.fn()}
          />
        </div>,
      );

      expect(scroller.scrollTop).toBe(0);
      expect(findByText(prose, 'Inserted paragraph one').getBoundingClientRect().top).toBe(0);
    } finally {
      restoreLayout();
    }
  });

  // --- A scroller laid out like a browser's, for what the fake layout above
  // cannot show: what reading layout at the wrong moment costs, and which
  // passes issue a correction at all.

  /** `count` unique paragraphs: tall enough (50px each) to scroll. */
  function paragraphs(count: number, from = 0): string {
    return Array.from({ length: count }, (_, i) => `Paragraph ${from + i} unique text.`).join(
      '\n\n',
    );
  }

  /**
   * The scroller as a browser lays it out: reading scrollTop clamps it to what
   * the viewer's blocks allow, and the clamp sticks. Records every scrollTo's
   * behavior; only an instant one moves it this tick (`scroll-behavior:
   * smooth`, index.css).
   */
  function modelScroller(scroller: HTMLElement) {
    let top = 0;
    const behaviors: (ScrollBehavior | undefined)[] = [];
    const max = () =>
      Math.max(
        0,
        (scroller.querySelector('.prose')?.children.length ?? 0) * ELEMENT_HEIGHT - VIEWPORT_HEIGHT,
      );
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => (top = Math.min(top, max())),
      set: (v: number) => {
        top = Math.max(0, Math.min(v, max()));
      },
    });
    scroller.scrollTo = ((options: ScrollToOptions) => {
      behaviors.push(options.behavior);
      if (options.behavior === 'instant') scroller.scrollTop = options.top ?? 0;
    }) as typeof scroller.scrollTo;
    return behaviors;
  }

  /**
   * installFakeLayout for a viewer that may be remounted (its container is
   * looked up on every call), with `shift.px` added below the first block:
   * content above the reader changing height partway through a pass, as an
   * image above them collapsing while it refetches, or a diagram landing.
   */
  function installLiveLayout(scroller: HTMLElement, shift = { px: 0 }): () => void {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this === scroller) return fakeRect(0, VIEWPORT_HEIGHT);
      const prose = scroller.querySelector('.prose');
      if (prose && this.parentElement === prose) {
        const idx = Array.from(prose.children).indexOf(this);
        const top = idx * ELEMENT_HEIGHT + (idx > 0 ? shift.px : 0) - scroller.scrollTop;
        return fakeRect(top, top + ELEMENT_HEIGHT);
      }
      return original.call(this);
    };
    return () => {
      Element.prototype.getBoundingClientRect = original;
    };
  }

  type ViewerProps = Parameters<typeof MarkdownViewer>[0];

  function viewerFor(markdown: string, props: Partial<ViewerProps> = {}) {
    return (
      <MarkdownViewer
        html={renderMarkdown(markdown)}
        cleanMarkdown={markdown}
        comments={[]}
        activeCommentId={null}
        selectionText={null}
        selectionOffset={null}
        onHighlightClick={vi.fn()}
        {...props}
      />
    );
  }

  it('keeps the offset through a remount instead of measuring the empty viewer', () => {
    // App mounts a new viewer when the diff overlay closes. It starts empty,
    // and a layout read before it is filled clamps the scroller to that empty
    // height: the reader dropped to the top.
    const markdown = paragraphs(30);
    const { container, rerender } = render(
      <div className="overflow-y-auto">{viewerFor(markdown)}</div>,
    );
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    modelScroller(scroller);
    const restoreLayout = installLiveLayout(scroller);
    try {
      scroller.scrollTop = 600;

      rerender(
        <div className="overflow-y-auto">
          <section>{viewerFor(markdown)}</section>
        </div>,
      );

      expect(scroller.scrollTop).toBe(600);
    } finally {
      restoreLayout();
    }
  });

  /** jsdom implements no scrollIntoView; the search pass calls it. */
  function stubIntoView() {
    const original = Element.prototype.scrollIntoView;
    const intoView = vi.fn();
    Element.prototype.scrollIntoView = intoView;
    return { intoView, restore: () => (Element.prototype.scrollIntoView = original) };
  }

  it('does not correct the position on a pass that moves the active comment or the search', () => {
    // A jump to a comment starts its smooth scroll before the commit that
    // marks it active, and a find-bar step starts one in the search pass. If
    // anything above the reader changes height meanwhile, a correction would
    // be an instant scrollTo, which aborts the jump.
    const markdown = paragraphs(30);
    const shift = { px: 0 };
    const { intoView, restore } = stubIntoView();
    const search = { searchQuery: 'unique text', searchActiveIndex: 0 };
    const { container, rerender } = render(
      <div className="overflow-y-auto">{viewerFor(markdown, search)}</div>,
    );
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const behaviors = modelScroller(scroller);
    const restoreLayout = installLiveLayout(scroller, shift);
    try {
      scroller.scrollTop = 600;
      intoView.mockClear();

      rerender(
        <div className="overflow-y-auto">
          {viewerFor(markdown, {
            ...search,
            activeCommentId: 'c1',
            // Runs partway through the pass, after the rebuild.
            onSearchCount: () => {
              shift.px = 40;
            },
          })}
        </div>,
      );
      expect(intoView).not.toHaveBeenCalled();

      rerender(
        <div className="overflow-y-auto">
          {viewerFor(markdown, {
            ...search,
            searchActiveIndex: 1,
            activeCommentId: 'c1',
            onSearchCount: () => {
              shift.px = 80;
            },
          })}
        </div>,
      );
      expect(intoView).toHaveBeenCalledTimes(1);

      expect(behaviors).toEqual([]);
    } finally {
      restoreLayout();
      restore();
    }
  });

  it('corrects the position on a pass that only repaints the selection', () => {
    // Highlights do not move text, but the rebuild re-inserts every image and
    // diagram, and one that refetches or collapses still shifts what is below.
    const markdown = paragraphs(30);
    const shift = { px: 0 };
    const { container, rerender } = render(
      <div className="overflow-y-auto">{viewerFor(markdown)}</div>,
    );
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const behaviors = modelScroller(scroller);
    const restoreLayout = installLiveLayout(scroller, shift);
    try {
      scroller.scrollTop = 600;

      rerender(
        <div className="overflow-y-auto">
          {viewerFor(markdown, {
            selectionText: 'Paragraph 3 unique text.',
            onSearchCount: () => {
              shift.px = 40;
            },
          })}
        </div>,
      );

      expect(behaviors).toEqual(['instant']);
      expect(scroller.scrollTop).toBe(640);
    } finally {
      restoreLayout();
    }
  });

  it('corrects an edit that also clears the active comment', () => {
    // Deleting a comment rewrites the file and clears the active comment in
    // one commit. The deletion started no jump, so the edit is corrected.
    const markdown = paragraphs(30);
    const { container, rerender } = render(
      <div className="overflow-y-auto">{viewerFor(markdown, { activeCommentId: 'c1' })}</div>,
    );
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const behaviors = modelScroller(scroller);
    const restoreLayout = installLiveLayout(scroller);
    try {
      scroller.scrollTop = 600;

      const edited = `${insertedAbove}\n\n${markdown}`;
      rerender(
        <div className="overflow-y-auto">{viewerFor(edited, { activeCommentId: null })}</div>,
      );

      expect(behaviors).toEqual(['instant']);
      expect(scroller.scrollTop).toBe(750);
    } finally {
      restoreLayout();
    }
  });

  it('corrects a pass that opens or closes the find bar with no query', () => {
    // App passes the query only while the bar is open: closing it turns
    // 'Paragraph' into undefined, opening it turns undefined into ''. Neither
    // scrolls anywhere, so neither is a jump to protect.
    const markdown = paragraphs(30);
    const shift = { px: 0 };
    const { intoView, restore } = stubIntoView();
    const { container, rerender } = render(
      <div className="overflow-y-auto">
        {viewerFor(markdown, { searchQuery: 'Paragraph 2 unique', searchActiveIndex: 0 })}
      </div>,
    );
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const behaviors = modelScroller(scroller);
    const restoreLayout = installLiveLayout(scroller, shift);
    try {
      scroller.scrollTop = 600;
      intoView.mockClear();

      rerender(
        <div className="overflow-y-auto">
          {viewerFor(markdown, {
            searchQuery: undefined,
            searchActiveIndex: 0,
            onSearchCount: () => {
              shift.px = 40;
            },
          })}
        </div>,
      );
      expect(behaviors).toEqual(['instant']);
      expect(scroller.scrollTop).toBe(640);

      rerender(
        <div className="overflow-y-auto">
          {viewerFor(markdown, {
            searchQuery: '',
            searchActiveIndex: 0,
            onSearchCount: () => {
              shift.px = 80;
            },
          })}
        </div>,
      );
      expect(behaviors).toEqual(['instant', 'instant']);
      expect(scroller.scrollTop).toBe(680);
      expect(intoView).not.toHaveBeenCalled();
    } finally {
      restoreLayout();
      restore();
    }
  });

  it('keeps the reader in place through an edit with the find bar open, without jumping to the match', () => {
    // The reader moved on from the match they found. An agent edit above them
    // must neither send them back to it nor leave them displaced by the edit.
    const markdown = paragraphs(30);
    const { intoView, restore } = stubIntoView();
    const search = { searchQuery: 'Paragraph 2 unique', searchActiveIndex: 0 };
    const { container, rerender } = render(
      <div className="overflow-y-auto">{viewerFor(markdown, search)}</div>,
    );
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const behaviors = modelScroller(scroller);
    const restoreLayout = installLiveLayout(scroller);
    try {
      scroller.scrollTop = 600;
      intoView.mockClear();

      const edited = `${insertedAbove}\n\n${markdown}`;
      rerender(<div className="overflow-y-auto">{viewerFor(edited, search)}</div>);

      expect(intoView).not.toHaveBeenCalled();
      // Paragraph 12 was at the top; three paragraphs landed above it.
      expect(behaviors).toEqual(['instant']);
      expect(scroller.scrollTop).toBe(750);
    } finally {
      restoreLayout();
      restore();
    }
  });

  it('leaves an arriving document to App, carrying no place over from the one before', () => {
    // The reader is on Paragraph 12 of one file. The next file has a block
    // with the same text further down; correcting toward it would scroll the
    // arriving document to a place that belongs to the other one.
    const { container, rerender } = render(
      <div className="overflow-y-auto">{viewerFor(paragraphs(30), { documentKey: '/a.md' })}</div>,
    );
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const behaviors = modelScroller(scroller);
    const restoreLayout = installLiveLayout(scroller);
    try {
      scroller.scrollTop = 600;

      const other = `${paragraphs(5, 100)}\n\n${paragraphs(30)}`;
      rerender(<div className="overflow-y-auto">{viewerFor(other, { documentKey: '/b.md' })}</div>);

      expect(behaviors).toEqual([]);
      expect(scroller.scrollTop).toBe(600);
    } finally {
      restoreLayout();
    }
  });

  it('scrolls to the active match when a document arrives, once its content is in', () => {
    const { intoView, restore } = stubIntoView();
    const search = { searchQuery: 'Paragraph 20 unique', searchActiveIndex: 0 };
    try {
      // A tab on its first load: nothing to show, nothing to scroll to.
      const { rerender } = render(
        <div className="overflow-y-auto">{viewerFor('', { ...search, documentKey: '/a.md' })}</div>,
      );
      expect(intoView).not.toHaveBeenCalled();

      // Its content lands: still the arrival.
      rerender(
        <div className="overflow-y-auto">
          {viewerFor(paragraphs(30), { ...search, documentKey: '/a.md' })}
        </div>,
      );
      expect(intoView).toHaveBeenCalledTimes(1);

      // A switch to another file.
      rerender(
        <div className="overflow-y-auto">
          {viewerFor(paragraphs(30), { ...search, documentKey: '/b.md' })}
        </div>,
      );
      expect(intoView).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it('finds a reader anchored on a Mermaid diagram again once its SVG lands', () => {
    // The diagram is a <pre> of source until its SVG renders, then a
    // .mermaid-block of SVG text with a per-render id: keyed by tag and text,
    // the anchor captured on the first never matches the second.
    const source = 'graph TD\n  A --> B';
    const markdown = `${paragraphs(10)}\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\n${paragraphs(19, 11)}`;
    const shift = { px: 0 };
    const { container, rerender } = render(
      <div className="overflow-y-auto">{viewerFor(markdown, { mermaidSvgMap: new Map() })}</div>,
    );
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    const prose = container.querySelector('.prose') as HTMLElement;
    modelScroller(scroller);
    const restoreLayout = installLiveLayout(scroller, shift);
    try {
      expect(prose.children[10].tagName).toBe('PRE');
      // The diagram's top is 20px above the viewport.
      scroller.scrollTop = 520;

      rerender(
        <div className="overflow-y-auto">
          {viewerFor(markdown, {
            mermaidSvgMap: new Map([
              [
                source,
                {
                  svg: '<svg id="mermaid-svg-3"><style>#mermaid-svg-3 .node{fill:red}</style><text>A</text><text>B</text></svg>',
                },
              ],
            ]),
            onSearchCount: () => {
              shift.px = 40;
            },
          })}
        </div>,
      );

      expect(prose.children[10].classList.contains('mermaid-block')).toBe(true);
      // Still 20px above the viewport, 40px further down the document.
      expect(scroller.scrollTop).toBe(560);
    } finally {
      restoreLayout();
    }
  });
});
