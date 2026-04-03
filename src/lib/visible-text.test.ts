// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  collectVisibleTextNodes,
  getVisibleTextContent,
  getVisibleTextOffset,
} from './visible-text';

describe('visible-text helpers', () => {
  it('ignores hidden text containers such as svg defs and style tags', () => {
    document.body.innerHTML = `
      <div id="root">
        Intro
        <style>.x { color: red; }</style>
        <svg>
          <defs>marker text</defs>
          <desc>diagram description</desc>
          <text>Visible label</text>
        </svg>
        <script>console.log('ignore me')</script>
        <span>Outro</span>
      </div>
    `;

    const root = document.getElementById('root')!;
    expect(getVisibleTextContent(root).replace(/\s+/g, ' ').trim()).toBe(
      'Intro Visible label Outro',
    );
  });

  it('collects only visible text nodes', () => {
    document.body.innerHTML = `
      <div id="root">
        <span>Alpha</span>
        <svg><metadata>hidden</metadata><text>Beta</text></svg>
        <template>Gamma</template>
        <span>Delta</span>
      </div>
    `;

    const root = document.getElementById('root')!;
    expect(
      collectVisibleTextNodes(root)
        .map((node) => node.textContent?.trim())
        .filter(Boolean),
    ).toEqual(['Alpha', 'Beta', 'Delta']);
  });

  it('computes offsets without counting hidden svg text', () => {
    document.body.innerHTML =
      '<div id="root"><span id="before">Alpha </span><svg><defs>hidden marker</defs><text>Beta</text></svg><span id="after"> Gamma</span></div>';

    const root = document.getElementById('root')!;
    const betaNode = root.querySelector('svg text')!.firstChild!;
    const gammaNode = document.getElementById('after')!.firstChild!;

    expect(getVisibleTextOffset(root, betaNode, 2)).toBe('Alpha '.length + 2);
    expect(getVisibleTextOffset(root, gammaNode, 1)).toBe('Alpha Beta'.length + 1);
  });

  it('resolves Element targetNode with offset pointing to a child index', () => {
    document.body.innerHTML =
      '<div id="root"><span id="parent"><em>Hello</em><strong> World</strong></span></div>';

    const root = document.getElementById('root')!;
    const parent = document.getElementById('parent')!;

    // offset=1 means the 2nd child node (<strong> World</strong>)
    // Should resolve to the text node inside <strong> at offset 0
    expect(getVisibleTextOffset(root, parent, 1)).toBe('Hello'.length);
  });

  it('resolves Element targetNode when offset === childNodes.length (after last child)', () => {
    // Use a parent whose children are bare text nodes so the "after last child"
    // path resolves without needing to descend through wrapper elements.
    document.body.innerHTML = '<div id="root"><span id="parent">Hello World</span></div>';

    const root = document.getElementById('root')!;
    const parent = document.getElementById('parent')!;

    // parent has 1 child text node "Hello World"; offset 1 === childNodes.length
    // means "after last child" — should return end of the text node (length 11)
    expect(getVisibleTextOffset(root, parent, parent.childNodes.length)).toBe('Hello World'.length);
  });
});
