export interface CommentTemplate {
  label: string;
  text: string;
}

export interface AppSettings {
  templates: CommentTemplate[];
  commentMaxLength: number;
  showTemplatesByDefault: boolean;
  /** Enable resolve/reopen workflow for human-to-human review. When off, comments are simply deleted after being addressed. */
  enableResolve: boolean;
  /** Skip the "Comment" button and go straight to the comment form when text is selected. */
  quickComment: boolean;
}

export const DEFAULT_TEMPLATES: CommentTemplate[] = [
  { label: 'Rewrite this', text: 'Rewrite this section — it needs to be clearer.' },
  { label: 'Add detail', text: 'Add more detail here.' },
  { label: 'Remove', text: 'Remove this — it is not needed.' },
  { label: 'Needs example', text: 'Add an example to illustrate this.' },
  { label: 'Too vague', text: 'This is too vague — be more specific.' },
  { label: 'Fix formatting', text: 'Fix the formatting in this section.' },
  { label: 'Factually wrong', text: 'This is factually incorrect — please verify and correct.' },
  { label: 'Out of scope', text: 'This is out of scope — remove or move to a separate doc.' },
];

export const DEFAULT_SETTINGS: AppSettings = {
  templates: DEFAULT_TEMPLATES,
  commentMaxLength: 1000,
  showTemplatesByDefault: true,
  enableResolve: false,
  quickComment: false,
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
    ? parsed.templates.filter(
        (t: unknown) =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as Record<string, unknown>).label === 'string' &&
          typeof (t as Record<string, unknown>).text === 'string',
      )
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
  };
}
