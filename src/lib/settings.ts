export interface CommentTemplate {
  label: string;
  text: string;
}

export type DocWidth = 'narrow' | 'default' | 'wide';

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
  proseFont: 'serif' | 'sans';
  /** Maximum prose column width in the rendered view (see DOC_WIDTH_COLS). */
  docWidth: DocWidth;
}

export const DEFAULT_TEMPLATES: CommentTemplate[] = [
  { label: 'Rewrite this', text: 'Rewrite this section to make it clearer.' },
  { label: 'Add detail', text: 'Add more detail here.' },
  { label: 'Remove', text: 'Remove this; it is not needed.' },
  { label: 'Needs example', text: 'Add an example to illustrate this.' },
  { label: 'Too vague', text: 'This is too vague. Be more specific.' },
  { label: 'Fix formatting', text: 'Fix the formatting in this section.' },
  { label: 'Factually wrong', text: 'This is factually incorrect. Please verify and correct.' },
  { label: 'Out of scope', text: 'This is out of scope. Remove it or move it to a separate doc.' },
];

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

export const DEFAULT_SETTINGS: AppSettings = {
  templates: DEFAULT_TEMPLATES,
  commentMaxLength: 1000,
  showTemplatesByDefault: true,
  enableResolve: false,
  quickComment: false,
  mermaidFullscreenPanelCollapsed: false,
  proseFont: 'serif',
  docWidth: 'default',
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
  return {
    templates: validTemplates as CommentTemplate[],
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
    proseFont:
      parsed.proseFont === 'sans' || parsed.proseFont === 'serif'
        ? parsed.proseFont
        : DEFAULT_SETTINGS.proseFont,
    docWidth:
      parsed.docWidth === 'narrow' || parsed.docWidth === 'default' || parsed.docWidth === 'wide'
        ? parsed.docWidth
        : DEFAULT_SETTINGS.docWidth,
  };
}
