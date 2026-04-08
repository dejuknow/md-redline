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

const STORAGE_KEY = 'md-redline-settings';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
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
      templates: validTemplates,
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
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable
  }
  // Dual-write to disk (fire-and-forget)
  import('./preferences-client')
    .then(({ savePreferencesToDisk }) => {
      savePreferencesToDisk({ settings: settings as unknown as Record<string, unknown> });
    })
    .catch(() => {});
}
