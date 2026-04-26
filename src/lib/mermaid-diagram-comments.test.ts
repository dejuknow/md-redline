// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { commentsForDiagram, orderThreadsBySvgPosition } from './mermaid-diagram-comments';
import type { MdComment } from '../types';

const makeComment = (id: string, anchor: string): MdComment => ({
  id,
  anchor,
  text: 'note',
  author: 'tester',
  timestamp: '2026-04-25T00:00:00Z',
});

describe('commentsForDiagram', () => {
  it('returns only comments whose anchor text appears in the diagram source labels', () => {
    const diagramSource = `flowchart TD
  A[Login] --> B[Dashboard]
  B --> C[Profile]`;
    const comments = [
      makeComment('1', 'Login'),
      makeComment('2', 'Dashboard'),
      makeComment('3', 'SomethingElse'),
    ];
    const result = commentsForDiagram(diagramSource, comments);
    expect(result.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('returns an empty array when no comments match', () => {
    const diagramSource = `flowchart TD
  A[Login] --> B[Dashboard]`;
    expect(commentsForDiagram(diagramSource, [])).toEqual([]);
  });

  it('with cleanMarkdown, attributes a shared label to the diagram whose block contains the comment marker', () => {
    const diagram1 = `flowchart TD
  A[API Gateway] --> B[Service]`;
    const diagram2 = `sequenceDiagram
  participant G as API Gateway
  G->>G: ping`;
    // insertComment relocates a marker that resolves inside a fenced block to
    // the start of that block's opening fence line — that's where a real
    // diagram-anchored comment marker lives. Position the markers there to
    // mirror real-world insertComment placement.
    const fence1 = '```mermaid\n' + diagram1 + '\n```\n';
    const fence2 = '```mermaid\n' + diagram2 + '\n```\n';
    const md = 'pre1\n' + fence1 + 'between\n' + fence2;
    const marker1 = md.indexOf('```mermaid');
    const marker2 = md.indexOf('```mermaid', marker1 + 5);
    const c1: MdComment = { ...makeComment('c1', 'API Gateway'), cleanOffset: marker1 };
    const c2: MdComment = { ...makeComment('c2', 'API Gateway'), cleanOffset: marker2 };

    expect(commentsForDiagram(diagram1, [c1, c2], md).map((c) => c.id)).toEqual(['c1']);
    expect(commentsForDiagram(diagram2, [c1, c2], md).map((c) => c.id)).toEqual(['c2']);
  });

  it('does not attribute prose-anchored comments to a later diagram that shares the label', () => {
    // A comment placed in prose BEFORE the first diagram (its marker lives in
    // the prose region) must not bleed into the diagram's panel even when its
    // anchor text happens to match a node label downstream.
    const diagram = `flowchart TD\n  A[Login] --> B[Dashboard]`;
    const md =
      'Welcome to the Login page. <!-- @comment{...} -->\n' +
      '```mermaid\n' +
      diagram +
      '\n```\n';
    const proseMarker = md.indexOf('<!-- @comment');
    const c: MdComment = { ...makeComment('prose', 'Login'), cleanOffset: proseMarker };
    expect(commentsForDiagram(diagram, [c], md).map((c) => c.id)).toEqual([]);
  });

  it('without cleanMarkdown, falls back to plain anchor matching (no disambiguation)', () => {
    const diagram = `flowchart TD\n  A[API Gateway]`;
    const c1: MdComment = { ...makeComment('c1', 'API Gateway'), cleanOffset: 9999 };
    expect(commentsForDiagram(diagram, [c1]).map((c) => c.id)).toEqual(['c1']);
  });

  it('attributes comments inside the source block to that diagram', () => {
    const diagram = `flowchart TD\n  A[API Gateway]`;
    const md =
      'prose\n```mermaid\n' +
      diagram +
      '\n<!-- @comment{...} -->\n```\nafter\n';
    const markerOffset = md.indexOf('<!-- @comment');
    const c: MdComment = { ...makeComment('inside', 'API Gateway'), cleanOffset: markerOffset };
    expect(commentsForDiagram(diagram, [c], md).map((c) => c.id)).toEqual(['inside']);
  });

  it('keeps comments with null cleanOffset visible (cannot disambiguate)', () => {
    const diagram = `flowchart TD\n  A[API Gateway]`;
    const md = '```mermaid\n' + diagram + '\n```\n';
    const c: MdComment = makeComment('no-offset', 'API Gateway');
    expect(commentsForDiagram(diagram, [c], md).map((c) => c.id)).toEqual(['no-offset']);
  });

  it('returns the unfiltered match list when the diagram source is not found in cleanMarkdown', () => {
    // Live-edit race: markdown is mid-update and no longer contains the source.
    // We fall back to anchor-only matching rather than dropping the comment.
    const diagram = `flowchart TD\n  A[API Gateway]`;
    const md = 'completely unrelated markdown that does not contain the source';
    const c: MdComment = { ...makeComment('c', 'API Gateway'), cleanOffset: 0 };
    expect(commentsForDiagram(diagram, [c], md).map((c) => c.id)).toEqual(['c']);
  });

  it('handles two diagrams with identical sources (duplicate blocks)', () => {
    // Both diagrams have the same source string. Without blockIndex, our
    // position lookup falls back to indexOf which finds the first
    // occurrence — both blocks would share comments attributed to the
    // first block.
    const diagram = `flowchart TD\n  A[Foo]`;
    const md = '```mermaid\n' + diagram + '\n```\n```mermaid\n' + diagram + '\n```\n';
    const block1End = md.indexOf('```\n', md.indexOf('```mermaid')) + 3;
    const c: MdComment = { ...makeComment('c', 'Foo'), cleanOffset: block1End - 5 };
    expect(commentsForDiagram(diagram, [c], md).map((c) => c.id)).toEqual(['c']);
  });

  it('with blockIndex, attributes comments to the specific copy of a duplicate diagram', () => {
    const diagram = `flowchart TD\n  A[Foo]`;
    const md = '```mermaid\n' + diagram + '\n```\n```mermaid\n' + diagram + '\n```\n';
    // Marker INSIDE block 1 (first copy)
    const block1FenceStart = md.indexOf('```mermaid');
    // Marker INSIDE block 2 (second copy) — at the start of its fence
    const block2FenceStart = md.indexOf('```mermaid', block1FenceStart + 5);
    const c1: MdComment = { ...makeComment('c1', 'Foo'), cleanOffset: block1FenceStart };
    const c2: MdComment = { ...makeComment('c2', 'Foo'), cleanOffset: block2FenceStart };

    // Block 0 should only see c1; block 1 should only see c2.
    expect(commentsForDiagram(diagram, [c1, c2], md, 0).map((c) => c.id)).toEqual(['c1']);
    expect(commentsForDiagram(diagram, [c1, c2], md, 1).map((c) => c.id)).toEqual(['c2']);
  });
});

describe('orderThreadsBySvgPosition', () => {
  it('returns comments unchanged with null positions when svg is null', () => {
    const comments = [makeComment('a', 'Foo'), makeComment('b', 'Bar')];
    const result = orderThreadsBySvgPosition(comments, null);
    expect(result).toEqual([
      { comment: comments[0], top: null },
      { comment: comments[1], top: null },
    ]);
  });

  it('orders comments by their text element y-position when svg is provided', () => {
    // Build a minimal fake SVG with three text nodes whose getBBox returns
    // distinct y values out of source order.
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
    document.body.appendChild(svg);
    const mkText = (label: string, y: number) => {
      const t = document.createElementNS(NS, 'text');
      t.textContent = label;
      svg.appendChild(t);
      (t as unknown as SVGGraphicsElement).getBBox = () =>
        ({ x: 0, y, width: 10, height: 10 }) as DOMRect;
      return t;
    };
    mkText('Bottom', 100);
    mkText('Top', 10);
    mkText('Middle', 50);
    const result = orderThreadsBySvgPosition(
      [makeComment('1', 'Bottom'), makeComment('2', 'Top'), makeComment('3', 'Middle')],
      svg,
    );
    expect(result.map((r) => r.comment.id)).toEqual(['2', '3', '1']);
    document.body.removeChild(svg);
  });

  it('places comments with no matching text node at the end of the list', () => {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
    document.body.appendChild(svg);
    const t = document.createElementNS(NS, 'text');
    t.textContent = 'Found';
    svg.appendChild(t);
    (t as unknown as SVGGraphicsElement).getBBox = () =>
      ({ x: 0, y: 50, width: 10, height: 10 }) as DOMRect;
    const result = orderThreadsBySvgPosition(
      [makeComment('missing', 'NotInSvg'), makeComment('present', 'Found')],
      svg,
    );
    expect(result.map((r) => r.comment.id)).toEqual(['present', 'missing']);
    document.body.removeChild(svg);
  });
});
