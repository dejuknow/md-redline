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
    expect(getVisibleTextContent(root).replace(/\s+/g, ' ').trim()).toBe('Intro Visible label Outro');
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
    document.body.innerHTML = '<div id="root"><span id="before">Alpha </span><svg><defs>hidden marker</defs><text>Beta</text></svg><span id="after"> Gamma</span></div>';

    const root = document.getElementById('root')!;
    const betaNode = root.querySelector('svg text')!.firstChild!;
    const gammaNode = document.getElementById('after')!.firstChild!;

    expect(getVisibleTextOffset(root, betaNode, 2)).toBe('Alpha '.length + 2);
    expect(getVisibleTextOffset(root, gammaNode, 1)).toBe('Alpha Beta'.length + 1);
  });
});
