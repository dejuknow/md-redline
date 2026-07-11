import { describe, it, expect } from 'vitest';
import { parseSettings, DEFAULT_SETTINGS, DEFAULT_TEMPLATES } from './settings';

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
    expect(parseSettings({ enableResolve: 'yes' }).enableResolve).toBe(false);
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
    expect(result.enableResolve).toBe(false);
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
