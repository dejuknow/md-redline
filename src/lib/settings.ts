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
  /** Which HTML comments stay hidden even with renderHtmlComments on. */
  hiddenComments: HiddenCommentSettings;
}

/**
 * Stored per tool, not per word, so a word added to or removed from a tool in
 * a later release follows that tool's checkbox instead of turning into one of
 * the reader's own words.
 */
export interface HiddenCommentSettings {
  /** Ids of tools the reader unticked, so that tool's comments render. */
  shownTools: string[];
  /** The reader's own words. A comment opening with one stays hidden. */
  custom: string[];
  /** The "Your own" checkbox: whether `custom` applies at all. */
  customEnabled: boolean;
}

/** A tool whose directives live in HTML comments, as one row in Settings. */
export interface HiddenCommentTool {
  /** Stable key for HiddenCommentSettings.shownTools. Never rename one. */
  id: string;
  label: string;
  prefixes: string[];
}

/**
 * Comment bodies addressed to a tool rather than a reader, in label order.
 * Matched after `trimStart`, case-sensitively, and as a whole word when the
 * prefix ends in a letter or digit (see isHiddenComment in the pipeline).
 * Case-sensitive on purpose: most directives are lowercase, while a person's
 * note opens with a capital, so `more` hides `<!-- more -->` but not
 * `<!-- More thought needed -->`. Each spelling a tool writes is listed. The
 * cost: a fixed-case directive (`TOC`, `DOCTOC SKIP`) or a lowercase one
 * (`no toc`) also hides a note that opens with exactly those letters, which is
 * what each tool's checkbox in Settings is for.
 */
export const DEFAULT_HIDDEN_COMMENT_TOOLS: HiddenCommentTool[] = [
  { id: 'alex', label: 'alex', prefixes: ['alex ignore', 'alex disable', 'alex enable'] },
  {
    id: 'all-contributors',
    label: 'all-contributors',
    prefixes: ['ALL-CONTRIBUTORS-LIST', 'ALL-CONTRIBUTORS-BADGE'],
  },
  {
    id: 'cspell',
    label: 'cSpell',
    prefixes: ['cSpell:', 'cspell:', 'spell-checker:', 'spellchecker:'],
  },
  { id: 'deno-fmt', label: 'Deno fmt', prefixes: ['deno-fmt-ignore'] },
  {
    id: 'doctoc',
    label: 'doctoc',
    prefixes: [
      'START doctoc',
      'END doctoc',
      "DON'T EDIT THIS SECTION",
      'DOCTOC SKIP',
      'DOCTOC EXCLUDE',
    ],
  },
  {
    id: 'markdown-all-in-one',
    label: 'Markdown All in One',
    prefixes: ['omit from toc', 'omit in toc', 'no toc'],
  },
  {
    id: 'markdown-link-check',
    label: 'markdown-link-check',
    prefixes: ['markdown-link-check-disable', 'markdown-link-check-enable'],
  },
  {
    id: 'markdownlint',
    label: 'markdownlint',
    prefixes: [
      'markdownlint-disable',
      'markdownlint-enable',
      'markdownlint-capture',
      'markdownlint-restore',
      'markdownlint-configure-file',
    ],
  },
  { id: 'prettier', label: 'Prettier', prefixes: ['prettier-ignore'] },
  { id: 'read-more', label: 'Read-more cut', prefixes: ['more', 'truncate'] },
  {
    id: 'remark-lint',
    label: 'remark-lint',
    prefixes: ['lint disable', 'lint enable', 'lint ignore'],
  },
  { id: 'textlint', label: 'textlint', prefixes: ['textlint-disable', 'textlint-enable'] },
  { id: 'toc', label: 'TOC markers', prefixes: ['toc', 'tocstop', 'TOC', '/TOC'] },
  // Bare `vale` covers every form: `vale off`, `vale Style.Rule = NO`, `vale style = X`.
  { id: 'vale', label: 'Vale', prefixes: ['vale'] },
];

/** Every shipped prefix, for callers that render with no settings at all. */
export const DEFAULT_HIDDEN_COMMENT_PREFIXES: string[] = DEFAULT_HIDDEN_COMMENT_TOOLS.flatMap(
  (tool) => tool.prefixes,
);

export const DEFAULT_HIDDEN_COMMENTS: HiddenCommentSettings = {
  shownTools: [],
  custom: [],
  customEnabled: true,
};

/** The prefixes that currently hide a comment, as the plain list the pipeline takes. */
export function getEnabledHiddenCommentPrefixes(settings: HiddenCommentSettings): string[] {
  const tools = DEFAULT_HIDDEN_COMMENT_TOOLS.filter((t) => !settings.shownTools.includes(t.id));
  const shipped = tools.flatMap((t) => t.prefixes);
  return settings.customEnabled ? [...shipped, ...settings.custom] : shipped;
}

/** Trimmed, non-empty, first occurrence wins. */
function cleanWords(value: unknown[]): string[] {
  const words = value
    .filter((w): w is string => typeof w === 'string')
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  return [...new Set(words)];
}

/**
 * Validate a stored `hiddenComments` value. Null when it is not an object, so
 * the caller can fall back. Shared with the server's persistence allowlist
 * (server/preferences.ts).
 */
export function normalizeHiddenCommentSettings(value: unknown): HiddenCommentSettings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return {
    shownTools: Array.isArray(v.shownTools) ? cleanWords(v.shownTools) : [],
    custom: Array.isArray(v.custom) ? cleanWords(v.custom) : [],
    customEnabled: typeof v.customEnabled === 'boolean' ? v.customEnabled : true,
  };
}

/**
 * The words each tool had in #124's first version, which stored one
 * `{ prefix, enabled }` entry per word under `hiddenCommentPrefixes`. That
 * format reached main but never a release, so only people running main have
 * it on disk. Frozen: only migrateLegacyHiddenCommentPrefixes reads it.
 */
const LEGACY_PREFIXES_BY_TOOL: Record<string, string[]> = {
  prettier: ['prettier-ignore'],
  markdownlint: [
    'markdownlint-disable',
    'markdownlint-enable',
    'markdownlint-capture',
    'markdownlint-restore',
    'markdownlint-configure-file',
  ],
  'remark-lint': ['lint disable', 'lint enable', 'lint ignore'],
  'deno-fmt': ['deno-fmt-ignore'],
  textlint: ['textlint-disable', 'textlint-enable'],
  alex: ['alex ignore', 'alex disable', 'alex enable'],
  vale: ['vale off', 'vale on'],
  cspell: ['cSpell:', 'cspell:', 'spell-checker:', 'spellchecker:'],
  // #124 had one "TOC generators" group; it is two tools now.
  toc: ['toc', 'tocstop'],
  doctoc: ['START doctoc', 'END doctoc'],
  'read-more': ['more'],
};
const LEGACY_PREFIXES = new Set(Object.values(LEGACY_PREFIXES_BY_TOOL).flat());

/**
 * Convert #124's per-word `hiddenCommentPrefixes`. Per-word choices do not fit
 * a per-tool setting, so where they disagree the conversion errs toward
 * showing: nothing that rendered before is hidden after. A tool is shown if
 * any of its words was switched off, and a word of the reader's own that was
 * switched off is dropped, since it hid nothing. When every one of their own
 * words was off, the words are kept and the switch is off.
 */
export function migrateLegacyHiddenCommentPrefixes(value: unknown): HiddenCommentSettings | null {
  if (!Array.isArray(value)) return null;
  const entries = value.flatMap((e) => {
    if (typeof e !== 'object' || e === null) return [];
    const { prefix, enabled } = e as Record<string, unknown>;
    return typeof prefix === 'string'
      ? [{ prefix, enabled: typeof enabled === 'boolean' ? enabled : true }]
      : [];
  });
  const stored = new Map(entries.map((e) => [e.prefix, e.enabled]));
  const shownTools = Object.entries(LEGACY_PREFIXES_BY_TOOL)
    .filter(([, words]) => words.some((w) => stored.get(w) === false))
    .map(([id]) => id);
  const own = entries.filter((e) => !LEGACY_PREFIXES.has(e.prefix));
  const ownOn = own.filter((e) => e.enabled);
  const allOwnOff = own.length > 0 && ownOn.length === 0;
  return {
    shownTools,
    custom: cleanWords((allOwnOff ? own : ownOn).map((e) => e.prefix)),
    customEnabled: !allOwnOff,
  };
}

/** The stored `hiddenComments`, else a converted legacy list, else the defaults. */
/**
 * What stored settings say about hidden comments: `hiddenComments` if it is
 * valid, else a converted legacy list, else null. The one precedence rule,
 * shared by parseSettings and the server's allowlist so the two cannot drift.
 */
export function storedHiddenCommentSettings(
  settings: Record<string, unknown>,
): HiddenCommentSettings | null {
  return (
    normalizeHiddenCommentSettings(settings.hiddenComments) ??
    migrateLegacyHiddenCommentPrefixes(settings.hiddenCommentPrefixes)
  );
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
  hiddenComments: DEFAULT_HIDDEN_COMMENTS,
};

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
    hiddenComments: storedHiddenCommentSettings(parsed) ?? DEFAULT_HIDDEN_COMMENTS,
  };
}
