// This module is shared with the server (server/preferences.ts builds its
// persistence whitelist from AppSettings). Keep it free of browser, React,
// and Node-only imports.

export interface CommentTemplate {
  label: string;
  text: string;
}

export const DOC_WIDTHS = ['narrow', 'default', 'wide'] as const;
export type DocWidth = (typeof DOC_WIDTHS)[number];

export const PROSE_FONTS = ['serif', 'sans'] as const;
export type ProseFont = (typeof PROSE_FONTS)[number];

export const PROSE_SIZES = ['small', 'default', 'large'] as const;
export type ProseSize = (typeof PROSE_SIZES)[number];

export interface AppSettings {
  templates: CommentTemplate[];
  commentMaxLength: number;
  showTemplatesByDefault: boolean;
  /** Enable resolve/reopen workflow for human-to-human review. When off, comments are simply deleted after being addressed. */
  enableResolve: boolean;
  /** Skip the "Comment" button and go straight to the comment form when text is selected. */
  quickComment: boolean;
  /** When true, the comment thread panel in the Mermaid fullscreen view starts collapsed. Persists across sessions. */
  mermaidFullscreenPanelCollapsed: boolean;
  /** Typeface for rendered document prose. UI chrome always uses the sans face. */
  proseFont: ProseFont;
  /** Maximum prose column width in the rendered view (see DOC_WIDTH_COLS). */
  docWidth: DocWidth;
  /** Font size for rendered document prose (small 14px, default 16px, large 18px). */
  proseSize: ProseSize;
  /** Render a single newline in the source as a line break instead of a space. Off follows CommonMark. */
  keepLineBreaks: boolean;
  /** Render ordinary (non-@comment) HTML comments as muted content in the rendered view. */
  renderHtmlComments: boolean;
  /**
   * Comment bodies opening with an enabled prefix stay hidden. A shipped
   * prefix is switched off with `enabled`, never removed; only custom
   * prefixes are removed.
   */
  hiddenCommentPrefixes: HiddenCommentPrefixEntry[];
}

/** One stored hidden-comment-prefix preference: the prefix text and whether it is active. */
export interface HiddenCommentPrefixEntry {
  prefix: string;
  enabled: boolean;
}

/** A tool's shipped prefixes, grouped for display in Settings (one section per tool). */
export interface HiddenCommentPrefixGroup {
  tool: string;
  prefixes: string[];
}

/**
 * Comment bodies addressed to a tool rather than a reader, grouped by tool for
 * Settings. Matched after `trimStart` and as a whole word, so one entry covers
 * `<!--lint disable-->` and `<!-- lint disable -->`. The short entries (`more`,
 * `toc`, `tocstop`) also hide a note that opens with the same word; a reader
 * switches them off in Settings.
 */
export const DEFAULT_HIDDEN_COMMENT_GROUPS: HiddenCommentPrefixGroup[] = [
  { tool: 'Prettier', prefixes: ['prettier-ignore'] },
  {
    tool: 'markdownlint',
    prefixes: [
      'markdownlint-disable',
      'markdownlint-enable',
      'markdownlint-capture',
      'markdownlint-restore',
      'markdownlint-configure-file',
    ],
  },
  { tool: 'remark-lint', prefixes: ['lint disable', 'lint enable', 'lint ignore'] },
  { tool: 'Deno fmt', prefixes: ['deno-fmt-ignore'] },
  { tool: 'textlint', prefixes: ['textlint-disable', 'textlint-enable'] },
  { tool: 'alex', prefixes: ['alex ignore', 'alex disable', 'alex enable'] },
  { tool: 'Vale', prefixes: ['vale off', 'vale on'] },
  {
    tool: 'cSpell / Code Spell Checker',
    prefixes: ['cSpell:', 'cspell:', 'spell-checker:', 'spellchecker:'],
  },
  { tool: 'TOC generators', prefixes: ['toc', 'tocstop', 'START doctoc', 'END doctoc'] },
  { tool: 'Excerpt marker (Jekyll / Hugo / Zola)', prefixes: ['more'] },
];

export const DEFAULT_HIDDEN_COMMENT_PREFIXES: string[] = DEFAULT_HIDDEN_COMMENT_GROUPS.flatMap(
  (group) => group.prefixes,
);

/**
 * The tool a shipped prefix belongs to, for grouping stored/rendered rows.
 * Undefined for a custom (user-added) prefix — those get their own group.
 */
export function hiddenCommentPrefixGroupFor(prefix: string): string | undefined {
  return DEFAULT_HIDDEN_COMMENT_GROUPS.find((g) => g.prefixes.includes(prefix))?.tool;
}

/**
 * The rows Settings renders: every shipped default — as an enabled row if
 * the stored list has never seen it, per AppSettings.hiddenCommentPrefixes —
 * unioned with whatever is actually stored, in shipped order followed by any
 * custom entries in their stored order.
 */
export function mergeHiddenCommentPrefixEntries(
  stored: HiddenCommentPrefixEntry[],
): HiddenCommentPrefixEntry[] {
  const byPrefix = new Map(stored.map((entry) => [entry.prefix, entry]));
  const defaults = DEFAULT_HIDDEN_COMMENT_PREFIXES.map(
    (prefix) => byPrefix.get(prefix) ?? { prefix, enabled: true },
  );
  const custom = stored.filter((entry) => !DEFAULT_HIDDEN_COMMENT_PREFIXES.includes(entry.prefix));
  return [...defaults, ...custom];
}

/** The enabled prefixes, as the plain list the rendering pipeline takes. */
export function getEnabledHiddenCommentPrefixes(stored: HiddenCommentPrefixEntry[]): string[] {
  return mergeHiddenCommentPrefixEntries(stored)
    .filter((entry) => entry.enabled)
    .map((entry) => entry.prefix);
}

/**
 * Shipped templates. The first two are the one-tap pills on the selection
 * pill, so the two most-used verdicts lead: approve, then rewrite.
 */
export const DEFAULT_TEMPLATES: CommentTemplate[] = [
  { label: 'Agreed', text: 'Agreed with this. No change needed here.' },
  { label: 'Rewrite this', text: 'Rewrite this section to make it clearer and more specific.' },
  { label: 'Add detail', text: 'Add more detail here.' },
  { label: 'Remove', text: 'Remove this; it is not needed.' },
  { label: 'Needs example', text: 'Add an example to illustrate this.' },
  { label: 'Why this?', text: 'Why this approach over the alternatives? Explain the reasoning.' },
  { label: 'Factually wrong', text: 'This is factually incorrect. Please verify and correct.' },
  { label: 'Out of scope', text: 'This is out of scope. Remove it or move it to a separate doc.' },
];

/**
 * The pre-2026-07-28 shipped set (post-em-dash cleanup). A stored list that
 * still matches this exactly is an untouched default, so it is replaced with
 * the current defaults at parse time; any customization keeps the list as-is.
 */
const SUPERSEDED_DEFAULT_TEMPLATES: CommentTemplate[] = [
  { label: 'Rewrite this', text: 'Rewrite this section to make it clearer.' },
  { label: 'Add detail', text: 'Add more detail here.' },
  { label: 'Remove', text: 'Remove this; it is not needed.' },
  { label: 'Needs example', text: 'Add an example to illustrate this.' },
  { label: 'Too vague', text: 'This is too vague. Be more specific.' },
  { label: 'Fix formatting', text: 'Fix the formatting in this section.' },
  { label: 'Factually wrong', text: 'This is factually incorrect. Please verify and correct.' },
  { label: 'Out of scope', text: 'This is out of scope. Remove it or move it to a separate doc.' },
];

function isSupersededDefaultSet(templates: CommentTemplate[]): boolean {
  return (
    templates.length === SUPERSEDED_DEFAULT_TEMPLATES.length &&
    templates.every(
      (t, i) =>
        t.label === SUPERSEDED_DEFAULT_TEMPLATES[i].label &&
        t.text === SUPERSEDED_DEFAULT_TEMPLATES[i].text,
    )
  );
}

/**
 * Earlier default template texts, upgraded in place at parse time. Only
 * exact matches are rewritten, so user-customized templates are never
 * touched. (The old defaults used em-dashes.)
 */
const LEGACY_TEMPLATE_TEXTS = new Map<string, string>([
  ['Rewrite this section — it needs to be clearer.', 'Rewrite this section to make it clearer.'],
  ['Remove this — it is not needed.', 'Remove this; it is not needed.'],
  ['This is too vague — be more specific.', 'This is too vague. Be more specific.'],
  [
    'This is factually incorrect — please verify and correct.',
    'This is factually incorrect. Please verify and correct.',
  ],
  [
    'This is out of scope — remove or move to a separate doc.',
    'This is out of scope. Remove it or move it to a separate doc.',
  ],
]);

/**
 * Whether a review tracks per-comment open/resolved state.
 *
 * Shared with the server, which uses it as the fallback when an agent opens a
 * session without saying which mode it wants. Two independent defaults is how
 * a reader ended up looking at a resolve-mode sidebar while the agent had been
 * handed remove-mode instructions.
 */
export const DEFAULT_ENABLE_RESOLVE = true;

export const DEFAULT_SETTINGS: AppSettings = {
  templates: DEFAULT_TEMPLATES,
  commentMaxLength: 1000,
  showTemplatesByDefault: true,
  enableResolve: DEFAULT_ENABLE_RESOLVE,
  quickComment: false,
  mermaidFullscreenPanelCollapsed: false,
  proseFont: 'serif',
  docWidth: 'default',
  proseSize: 'default',
  keepLineBreaks: false,
  renderHtmlComments: true,
  hiddenCommentPrefixes: DEFAULT_HIDDEN_COMMENT_PREFIXES.map((prefix) => ({
    prefix,
    enabled: true,
  })),
};

/**
 * Validate one stored hiddenCommentPrefixes element: an object with a string
 * `prefix`, and `enabled` defaulting to true when it is not a boolean.
 * Anything else is dropped. Shared with the server's persistence allowlist
 * (server/preferences.ts).
 */
export function normalizeHiddenCommentPrefixEntry(value: unknown): HiddenCommentPrefixEntry | null {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (typeof v.prefix === 'string') {
      return { prefix: v.prefix, enabled: typeof v.enabled === 'boolean' ? v.enabled : true };
    }
  }
  return null;
}

/**
 * Parse and validate settings from an arbitrary input (e.g. the server's
 * preferences response). Falls back to DEFAULT_SETTINGS for any field that
 * is missing or invalidly typed. Pure function — no I/O.
 */
export function parseSettings(input: unknown): AppSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return DEFAULT_SETTINGS;
  }
  const parsed = input as Record<string, unknown>;
  const validTemplates = Array.isArray(parsed.templates)
    ? parsed.templates
        .filter(
          (t: unknown) =>
            typeof t === 'object' &&
            t !== null &&
            typeof (t as Record<string, unknown>).label === 'string' &&
            typeof (t as Record<string, unknown>).text === 'string',
        )
        .map((t) => {
          const template = t as CommentTemplate;
          const upgraded = LEGACY_TEMPLATE_TEXTS.get(template.text);
          return upgraded ? { ...template, text: upgraded } : template;
        })
    : DEFAULT_SETTINGS.templates;
  const templates = validTemplates as CommentTemplate[];
  return {
    templates: isSupersededDefaultSet(templates) ? DEFAULT_TEMPLATES : templates,
    commentMaxLength:
      typeof parsed.commentMaxLength === 'number' && parsed.commentMaxLength > 0
        ? parsed.commentMaxLength
        : DEFAULT_SETTINGS.commentMaxLength,
    showTemplatesByDefault:
      typeof parsed.showTemplatesByDefault === 'boolean'
        ? parsed.showTemplatesByDefault
        : DEFAULT_SETTINGS.showTemplatesByDefault,
    enableResolve:
      typeof parsed.enableResolve === 'boolean'
        ? parsed.enableResolve
        : DEFAULT_SETTINGS.enableResolve,
    quickComment:
      typeof parsed.quickComment === 'boolean'
        ? parsed.quickComment
        : DEFAULT_SETTINGS.quickComment,
    mermaidFullscreenPanelCollapsed:
      typeof parsed.mermaidFullscreenPanelCollapsed === 'boolean'
        ? parsed.mermaidFullscreenPanelCollapsed
        : DEFAULT_SETTINGS.mermaidFullscreenPanelCollapsed,
    proseFont: PROSE_FONTS.includes(parsed.proseFont as ProseFont)
      ? (parsed.proseFont as ProseFont)
      : DEFAULT_SETTINGS.proseFont,
    docWidth: DOC_WIDTHS.includes(parsed.docWidth as DocWidth)
      ? (parsed.docWidth as DocWidth)
      : DEFAULT_SETTINGS.docWidth,
    proseSize: PROSE_SIZES.includes(parsed.proseSize as ProseSize)
      ? (parsed.proseSize as ProseSize)
      : DEFAULT_SETTINGS.proseSize,
    keepLineBreaks:
      typeof parsed.keepLineBreaks === 'boolean'
        ? parsed.keepLineBreaks
        : DEFAULT_SETTINGS.keepLineBreaks,
    renderHtmlComments:
      typeof parsed.renderHtmlComments === 'boolean'
        ? parsed.renderHtmlComments
        : DEFAULT_SETTINGS.renderHtmlComments,
    // An empty stored list does not mean "render every comment":
    // mergeHiddenCommentPrefixEntries unions it with the shipped defaults. Hiding
    // nothing is stored as every default present with enabled: false.
    hiddenCommentPrefixes: Array.isArray(parsed.hiddenCommentPrefixes)
      ? parsed.hiddenCommentPrefixes
          .map(normalizeHiddenCommentPrefixEntry)
          .filter((e): e is HiddenCommentPrefixEntry => e !== null)
      : DEFAULT_SETTINGS.hiddenCommentPrefixes,
  };
}
