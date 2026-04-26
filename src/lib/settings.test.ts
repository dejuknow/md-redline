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
    };
    expect(parseSettings(full)).toEqual(full);
  });
});
