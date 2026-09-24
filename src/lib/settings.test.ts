import { describe, it, expect } from 'vitest';
import {
  parseSettings,
  DEFAULT_SETTINGS,
  DEFAULT_TEMPLATES,
  DEFAULT_ENABLE_RESOLVE,
  DEFAULT_HIDDEN_COMMENT_PREFIXES,
  DEFAULT_HIDDEN_COMMENT_GROUPS,
  mergeHiddenCommentPrefixEntries,
  getEnabledHiddenCommentPrefixes,
  hiddenCommentPrefixGroupFor,
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
      hiddenCommentPrefixes: [{ prefix: 'prettier-ignore', enabled: true }],
    };
    expect(parseSettings(full)).toEqual(full);
  });

  describe('HTML comment rendering', () => {
    it('defaults to rendering, with the shipped directive list hidden', () => {
      const parsed = parseSettings({});
      expect(parsed.renderHtmlComments).toBe(true);
      expect(parsed.hiddenCommentPrefixes).toEqual(DEFAULT_SETTINGS.hiddenCommentPrefixes);
    });

    it('keeps an explicitly EMPTY prefix list rather than restoring the defaults', () => {
      // An empty stored list is a legitimate "nothing customized yet" state —
      // falling back to the defaults here would make it impossible to persist.
      // (Whether every default then renders as enabled is a Settings-rendering
      // question, handled by mergeHiddenCommentPrefixEntries, not by parsing.)
      expect(parseSettings({ hiddenCommentPrefixes: [] }).hiddenCommentPrefixes).toEqual([]);
    });

    it('drops entries that are not an object with a string prefix', () => {
      expect(
        parseSettings({
          hiddenCommentPrefixes: [
            'toc',
            42,
            null,
            { enabled: false },
            { prefix: 'more', enabled: false },
            { prefix: 'toc' },
          ],
        }).hiddenCommentPrefixes,
      ).toEqual([
        { prefix: 'more', enabled: false },
        { prefix: 'toc', enabled: true },
      ]);
    });

    it('falls back to the defaults when the stored value is not an array', () => {
      expect(parseSettings({ hiddenCommentPrefixes: 'toc' }).hiddenCommentPrefixes).toEqual(
        DEFAULT_SETTINGS.hiddenCommentPrefixes,
      );
    });

    it('passes through the current {prefix, enabled} shape unchanged', () => {
      const input = {
        hiddenCommentPrefixes: [
          { prefix: 'prettier-ignore', enabled: false },
          { prefix: 'my-custom-directive', enabled: true },
        ],
      };
      expect(parseSettings(input).hiddenCommentPrefixes).toEqual(input.hiddenCommentPrefixes);
    });

    it('defaults a missing or invalid enabled field to true', () => {
      expect(
        parseSettings({
          hiddenCommentPrefixes: [{ prefix: 'toc' }, { prefix: 'more', enabled: 'yes' }],
        }).hiddenCommentPrefixes,
      ).toEqual([
        { prefix: 'toc', enabled: true },
        { prefix: 'more', enabled: true },
      ]);
    });
  });

  describe('hidden comment prefix grouping and projection', () => {
    it('derives the flat prefix list from the grouped defaults, in order', () => {
      expect(DEFAULT_HIDDEN_COMMENT_PREFIXES).toEqual(
        DEFAULT_HIDDEN_COMMENT_GROUPS.flatMap((g) => g.prefixes),
      );
    });

    it('looks up the shipped group for a built-in prefix and finds none for a custom one', () => {
      expect(hiddenCommentPrefixGroupFor('prettier-ignore')).toBe('Prettier');
      expect(hiddenCommentPrefixGroupFor('more')).toBe('Excerpt marker (Jekyll / Hugo / Zola)');
      expect(hiddenCommentPrefixGroupFor('my-custom-directive')).toBeUndefined();
    });

    it('unions a default the stored list has never seen in as enabled', () => {
      const merged = mergeHiddenCommentPrefixEntries([
        { prefix: 'prettier-ignore', enabled: false },
      ]);
      expect(merged.find((e) => e.prefix === 'prettier-ignore')).toEqual({
        prefix: 'prettier-ignore',
        enabled: false,
      });
      // 'toc' was never stored, so it renders as an enabled row.
      expect(merged.find((e) => e.prefix === 'toc')).toEqual({ prefix: 'toc', enabled: true });
    });

    it('appends custom entries after the shipped defaults', () => {
      const merged = mergeHiddenCommentPrefixEntries([
        { prefix: 'my-custom-directive', enabled: true },
      ]);
      expect(merged.at(-1)).toEqual({ prefix: 'my-custom-directive', enabled: true });
      expect(merged).toHaveLength(DEFAULT_HIDDEN_COMMENT_PREFIXES.length + 1);
    });

    it('projects only the enabled prefixes as a flat string[]', () => {
      const stored = [
        { prefix: 'prettier-ignore', enabled: false },
        { prefix: 'my-custom-directive', enabled: true },
      ];
      const enabled = getEnabledHiddenCommentPrefixes(stored);
      expect(enabled).not.toContain('prettier-ignore');
      expect(enabled).toContain('my-custom-directive');
      // Every other shipped default is still enabled by default.
      expect(enabled).toContain('toc');
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
