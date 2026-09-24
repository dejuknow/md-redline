import { describe, it, expect } from 'vitest';
import {
  parseSettings,
  DEFAULT_SETTINGS,
  DEFAULT_TEMPLATES,
  DEFAULT_ENABLE_RESOLVE,
  DEFAULT_HIDDEN_COMMENT_PREFIXES,
  DEFAULT_HIDDEN_COMMENT_TOOLS,
  DEFAULT_HIDDEN_COMMENTS,
  getEnabledHiddenCommentPrefixes,
  migrateLegacyHiddenCommentPrefixes,
} from './settings';

describe('parseSettings', () => {
  it('returns defaults for null', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults for undefined', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults for non-object input', () => {
    expect(parseSettings('not an object')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(true)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults for an array', () => {
    expect(parseSettings(['not', 'an', 'object'])).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults for empty object', () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('preserves valid enableResolve value', () => {
    expect(parseSettings({ enableResolve: true }).enableResolve).toBe(true);
  });

  it('falls back to default when enableResolve is not a boolean', () => {
    expect(parseSettings({ enableResolve: 'yes' }).enableResolve).toBe(DEFAULT_ENABLE_RESOLVE);
  });

  it('preserves valid quickComment value', () => {
    expect(parseSettings({ quickComment: true }).quickComment).toBe(true);
  });

  it('falls back to default when quickComment is not a boolean', () => {
    expect(parseSettings({ quickComment: 42 }).quickComment).toBe(false);
  });

  it('preserves valid showTemplatesByDefault value', () => {
    expect(parseSettings({ showTemplatesByDefault: true }).showTemplatesByDefault).toBe(true);
  });

  it('falls back to default when showTemplatesByDefault is not a boolean', () => {
    expect(parseSettings({ showTemplatesByDefault: null }).showTemplatesByDefault).toBe(true);
  });

  it('preserves valid commentMaxLength', () => {
    expect(parseSettings({ commentMaxLength: 1000 }).commentMaxLength).toBe(1000);
  });

  it('falls back to default for zero commentMaxLength', () => {
    expect(parseSettings({ commentMaxLength: 0 }).commentMaxLength).toBe(1000);
  });

  it('falls back to default for negative commentMaxLength', () => {
    expect(parseSettings({ commentMaxLength: -10 }).commentMaxLength).toBe(1000);
  });

  it('falls back to default for non-numeric commentMaxLength', () => {
    expect(parseSettings({ commentMaxLength: 'big' }).commentMaxLength).toBe(1000);
  });

  it('preserves valid templates array', () => {
    const templates = [{ label: 'Custom', text: 'Custom text' }];
    expect(parseSettings({ templates }).templates).toEqual(templates);
  });

  it('falls back to default templates when templates is not an array', () => {
    expect(parseSettings({ templates: 'not-an-array' }).templates).toEqual(DEFAULT_TEMPLATES);
  });

  it('handles partial settings (migration from older versions)', () => {
    const input = {
      templates: DEFAULT_TEMPLATES,
      commentMaxLength: 1000,
      showTemplatesByDefault: false,
    };
    const result = parseSettings(input);
    // An install predating this field adopts the current default rather than
    // being pinned to whatever it happened to be when they upgraded.
    expect(result.enableResolve).toBe(DEFAULT_ENABLE_RESOLVE);
    expect(result.quickComment).toBe(false);
    expect(result.commentMaxLength).toBe(1000);
    expect(result.showTemplatesByDefault).toBe(false);
  });

  it('preserves a full valid settings object', () => {
    const full = {
      templates: [{ label: 'A', text: 'B' }],
      commentMaxLength: 750,
      showTemplatesByDefault: true,
      enableResolve: true,
      quickComment: true,
      mermaidFullscreenPanelCollapsed: false,
      proseFont: 'serif',
      docWidth: 'wide',
      proseSize: 'large',
      keepLineBreaks: true,
      renderHtmlComments: false,
      hiddenComments: { shownTools: ['vale'], custom: ['TODO'], customEnabled: false },
    };
    expect(parseSettings(full)).toEqual(full);
  });

  describe('HTML comment rendering', () => {
    it('defaults to rendering, with every shipped tool hidden and no words of your own', () => {
      const parsed = parseSettings({});
      expect(parsed.renderHtmlComments).toBe(true);
      expect(parsed.hiddenComments).toEqual(DEFAULT_HIDDEN_COMMENTS);
    });

    it('trims, dedupes, and drops anything that is not a word', () => {
      expect(
        parseSettings({
          hiddenComments: {
            shownTools: ['vale', 3, 'vale'],
            custom: [' TODO ', '', 'TODO', null, 'DRAFT'],
            customEnabled: 'yes',
          },
        }).hiddenComments,
      ).toEqual({ shownTools: ['vale'], custom: ['TODO', 'DRAFT'], customEnabled: true });
    });

    it('falls back to the defaults when hiddenComments is not an object', () => {
      expect(parseSettings({ hiddenComments: ['vale'] }).hiddenComments).toEqual(
        DEFAULT_HIDDEN_COMMENTS,
      );
      expect(parseSettings({ hiddenComments: 'vale' }).hiddenComments).toEqual(
        DEFAULT_HIDDEN_COMMENTS,
      );
    });

    it('prefers a stored hiddenComments over a legacy list stored beside it', () => {
      expect(
        parseSettings({
          hiddenComments: { shownTools: [], custom: ['TODO'], customEnabled: true },
          hiddenCommentPrefixes: [{ prefix: 'vale off', enabled: false }],
        }).hiddenComments,
      ).toEqual({ shownTools: [], custom: ['TODO'], customEnabled: true });
    });
  });

  describe("converting #124's per-word list", () => {
    // What #124 stored after a reader toggled groups: an explicit
    // entry for every shipped word.
    const EVERY_LEGACY_WORD = [
      'prettier-ignore',
      'markdownlint-disable',
      'markdownlint-enable',
      'markdownlint-capture',
      'markdownlint-restore',
      'markdownlint-configure-file',
      'lint disable',
      'lint enable',
      'lint ignore',
      'deno-fmt-ignore',
      'textlint-disable',
      'textlint-enable',
      'alex ignore',
      'alex disable',
      'alex enable',
      'vale off',
      'vale on',
      'cSpell:',
      'cspell:',
      'spell-checker:',
      'spellchecker:',
      'toc',
      'tocstop',
      'START doctoc',
      'END doctoc',
      'more',
    ];

    it('does not turn shipped words into your own, even ones the new list renamed', () => {
      // The bug this format exists to fix: `vale off` and `vale on` are not in
      // the new list, and must not resurface as the reader's own words.
      const legacy = EVERY_LEGACY_WORD.map((prefix) => ({ prefix, enabled: true }));
      expect(
        migrateLegacyHiddenCommentPrefixes([...legacy, { prefix: 'asdf', enabled: true }]),
      ).toEqual({ shownTools: [], custom: ['asdf'], customEnabled: true });
    });

    it('shows a tool if any of its words was switched off, so nothing that rendered is hidden', () => {
      // The old fixture told readers to switch off just `vale off`.
      const migrated = migrateLegacyHiddenCommentPrefixes([
        { prefix: 'vale off', enabled: false },
        { prefix: 'vale on', enabled: true },
        { prefix: 'markdownlint-disable', enabled: true },
        { prefix: 'markdownlint-enable', enabled: true },
      ]);
      expect(migrated?.shownTools).toEqual(['vale']);
    });

    it('splits the old TOC group into the toc and doctoc tools', () => {
      const migrated = migrateLegacyHiddenCommentPrefixes([
        { prefix: 'toc', enabled: false },
        { prefix: 'tocstop', enabled: true },
        { prefix: 'START doctoc', enabled: true },
        { prefix: 'END doctoc', enabled: true },
      ]);
      expect(migrated?.shownTools).toEqual(['toc']);
    });

    it('drops an own word that was switched off, since it hid nothing', () => {
      expect(
        migrateLegacyHiddenCommentPrefixes([
          { prefix: 'TODO', enabled: true },
          { prefix: 'DRAFT', enabled: false },
        ]),
      ).toEqual({ shownTools: [], custom: ['TODO'], customEnabled: true });
    });

    it('keeps your own words with the switch off when every one of them was off', () => {
      expect(
        migrateLegacyHiddenCommentPrefixes([
          { prefix: 'TODO', enabled: false },
          { prefix: 'DRAFT', enabled: false },
        ]),
      ).toEqual({ shownTools: [], custom: ['TODO', 'DRAFT'], customEnabled: false });
    });

    it('treats an empty list as the defaults and skips entries without a string prefix', () => {
      expect(migrateLegacyHiddenCommentPrefixes([])).toEqual(DEFAULT_HIDDEN_COMMENTS);
      expect(
        migrateLegacyHiddenCommentPrefixes(['toc', 42, null, { enabled: false }, { prefix: 'x' }]),
      ).toEqual({ shownTools: [], custom: ['x'], customEnabled: true });
    });

    it('returns null for anything that is not a list, so parseSettings falls back', () => {
      expect(migrateLegacyHiddenCommentPrefixes(undefined)).toBeNull();
      expect(migrateLegacyHiddenCommentPrefixes('toc')).toBeNull();
    });

    it('is what parseSettings uses when only the legacy key is stored', () => {
      expect(
        parseSettings({
          hiddenCommentPrefixes: [
            { prefix: 'more', enabled: false },
            { prefix: 'TODO', enabled: true },
          ],
        }).hiddenComments,
      ).toEqual({ shownTools: ['read-more'], custom: ['TODO'], customEnabled: true });
    });
  });

  describe('the shipped tool list', () => {
    it('gives every tool a unique id', () => {
      const ids = DEFAULT_HIDDEN_COMMENT_TOOLS.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('is in label order, which is the order Settings shows', () => {
      const labels = DEFAULT_HIDDEN_COMMENT_TOOLS.map((t) => t.label);
      expect(labels).toEqual(
        [...labels].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
      );
    });

    it('flattens to the default prefix list', () => {
      expect(DEFAULT_HIDDEN_COMMENT_PREFIXES).toEqual(
        DEFAULT_HIDDEN_COMMENT_TOOLS.flatMap((t) => t.prefixes),
      );
    });
  });

  describe('getEnabledHiddenCommentPrefixes', () => {
    it('is every shipped prefix by default', () => {
      expect(getEnabledHiddenCommentPrefixes(DEFAULT_HIDDEN_COMMENTS)).toEqual(
        DEFAULT_HIDDEN_COMMENT_PREFIXES,
      );
    });

    it("leaves out a shown tool's words and adds your own while they are on", () => {
      const enabled = getEnabledHiddenCommentPrefixes({
        shownTools: ['vale'],
        custom: ['TODO'],
        customEnabled: true,
      });
      expect(enabled).not.toContain('vale');
      expect(enabled).toContain('prettier-ignore');
      expect(enabled.at(-1)).toBe('TODO');
    });

    it("shows one tool's markers without showing another tool's that look alike", () => {
      // One row per tool: showing markdown-toc's `toc` or the read-more `more`
      // leaves the VS Code TOC markers and Docusaurus's `truncate` hidden.
      const enabled = getEnabledHiddenCommentPrefixes({
        shownTools: ['toc', 'read-more'],
        custom: [],
        customEnabled: true,
      });
      expect(enabled).not.toContain('toc');
      expect(enabled).not.toContain('more');
      expect(enabled).toEqual(expect.arrayContaining(['TOC', '/TOC', 'truncate']));
    });

    it('leaves out your own words while they are switched off', () => {
      expect(
        getEnabledHiddenCommentPrefixes({ shownTools: [], custom: ['TODO'], customEnabled: false }),
      ).not.toContain('TODO');
    });
  });
});

describe('parseSettings docWidth', () => {
  it('defaults to default when absent or invalid', () => {
    expect(parseSettings({}).docWidth).toBe('default');
    expect(parseSettings({ docWidth: 'huge' }).docWidth).toBe('default');
  });

  it('accepts narrow, default, and wide', () => {
    expect(parseSettings({ docWidth: 'narrow' }).docWidth).toBe('narrow');
    expect(parseSettings({ docWidth: 'wide' }).docWidth).toBe('wide');
  });
});

describe('parseSettings keepLineBreaks', () => {
  it('defaults to off, which is CommonMark', () => {
    expect(DEFAULT_SETTINGS.keepLineBreaks).toBe(false);
    expect(parseSettings({}).keepLineBreaks).toBe(false);
  });

  it('keeps a stored boolean and ignores anything else', () => {
    expect(parseSettings({ keepLineBreaks: true }).keepLineBreaks).toBe(true);
    expect(parseSettings({ keepLineBreaks: 'yes' }).keepLineBreaks).toBe(false);
  });
});

describe('parseSettings superseded default template set', () => {
  const supersededDefaults = [
    { label: 'Rewrite this', text: 'Rewrite this section to make it clearer.' },
    { label: 'Add detail', text: 'Add more detail here.' },
    { label: 'Remove', text: 'Remove this; it is not needed.' },
    { label: 'Needs example', text: 'Add an example to illustrate this.' },
    { label: 'Too vague', text: 'This is too vague. Be more specific.' },
    { label: 'Fix formatting', text: 'Fix the formatting in this section.' },
    { label: 'Factually wrong', text: 'This is factually incorrect. Please verify and correct.' },
    {
      label: 'Out of scope',
      text: 'This is out of scope. Remove it or move it to a separate doc.',
    },
  ];

  it('replaces an untouched old default set with the current defaults', () => {
    expect(parseSettings({ templates: supersededDefaults }).templates).toEqual(DEFAULT_TEMPLATES);
  });

  it('leaves the list alone once any template was customized', () => {
    const customized = [
      ...supersededDefaults.slice(0, 7),
      { label: 'Out of scope', text: 'Move this to the appendix.' },
    ];
    expect(parseSettings({ templates: customized }).templates).toEqual(customized);
  });

  it('upgrades the em-dash era default set all the way to the current defaults', () => {
    const emDashEra = supersededDefaults.map((t) =>
      t.label === 'Too vague' ? { ...t, text: 'This is too vague — be more specific.' } : t,
    );
    expect(parseSettings({ templates: emDashEra }).templates).toEqual(DEFAULT_TEMPLATES);
  });
});

describe('parseSettings legacy template migration', () => {
  it('rewrites persisted copies of the old em-dash default texts', () => {
    const parsed = parseSettings({
      templates: [
        { label: 'Rewrite this', text: 'Rewrite this section — it needs to be clearer.' },
        { label: 'Custom', text: 'My own — template text.' },
      ],
    });
    expect(parsed.templates[0].text).toBe('Rewrite this section to make it clearer.');
    // Customized templates are never touched, even if they contain em-dashes.
    expect(parsed.templates[1].text).toBe('My own — template text.');
  });
});

describe('parseSettings proseFont', () => {
  it('defaults to serif when absent', () => {
    expect(parseSettings({}).proseFont).toBe('serif');
    expect(DEFAULT_SETTINGS.proseFont).toBe('serif');
  });

  it('accepts sans and serif', () => {
    expect(parseSettings({ proseFont: 'sans' }).proseFont).toBe('sans');
    expect(parseSettings({ proseFont: 'serif' }).proseFont).toBe('serif');
  });

  it('falls back to serif on invalid values', () => {
    expect(parseSettings({ proseFont: 'comic-sans' }).proseFont).toBe('serif');
    expect(parseSettings({ proseFont: 42 }).proseFont).toBe('serif');
  });
});

describe('parseSettings proseSize', () => {
  it('defaults missing or invalid values', () => {
    expect(parseSettings({}).proseSize).toBe('default');
    expect(parseSettings({ proseSize: 'huge' }).proseSize).toBe('default');
    expect(parseSettings({ proseSize: 7 }).proseSize).toBe('default');
  });
  it('accepts valid values', () => {
    expect(parseSettings({ proseSize: 'small' }).proseSize).toBe('small');
    expect(parseSettings({ proseSize: 'large' }).proseSize).toBe('large');
  });
});

describe('enableResolve default', () => {
  it('defaults to resolve mode', () => {
    // Pinned deliberately: the server reads the same constant as its fallback
    // when an agent opens a session without naming a mode, so a change here
    // silently changes what agents are instructed to do.
    expect(DEFAULT_ENABLE_RESOLVE).toBe(true);
    expect(parseSettings({}).enableResolve).toBe(true);
  });

  it('still honours an explicit false', () => {
    expect(parseSettings({ enableResolve: false }).enableResolve).toBe(false);
  });
});
