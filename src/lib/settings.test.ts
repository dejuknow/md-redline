import { describe, it, expect } from 'vitest';
import {
  parseSettings,
  DEFAULT_SETTINGS,
  DEFAULT_TEMPLATES,
  DEFAULT_ENABLE_RESOLVE,
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
    };
    expect(parseSettings(full)).toEqual(full);
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
