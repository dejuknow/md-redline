let mermaidModule: typeof import('mermaid') | null = null;
let initTheme: string | null = null;
let themeChangePromise: Promise<void> | null = null;

const FLOWCHART_CONFIG = {
  useMaxWidth: true,
  wrappingWidth: 200,
  rankSpacing: 70,
} as const;

async function getMermaid() {
  if (!mermaidModule) {
    mermaidModule = await import('mermaid');
    mermaidModule.default.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'default',
      htmlLabels: true,
      flowchart: FLOWCHART_CONFIG,
    });
    initTheme = 'default';
  }
  return mermaidModule.default;
}

// Maps app theme keys (from src/lib/themes.ts) to mermaid theme names.
// Keep in sync when adding new themes.
const THEME_MAP: Record<string, string> = {
  light: 'default',
  dark: 'dark',
  sepia: 'neutral',
  nord: 'dark',
  'rose-pine': 'dark',
  solarized: 'default',
  github: 'default',
  catppuccin: 'dark',
};

export function getMermaidTheme(appTheme: string): string {
  return THEME_MAP[appTheme] || 'default';
}

let renderCounter = 0;

export async function renderMermaidBlock(
  source: string,
  appTheme: string,
): Promise<{ svg: string } | { error: string }> {
  try {
    const mermaid = await getMermaid();
    const mermaidTheme = getMermaidTheme(appTheme);

    // Serialize theme changes to avoid concurrent re-initialization races.
    // After awaiting a pending promise, re-check in case a newer theme was
    // requested while we were waiting (rapid toggling).
    while (mermaidTheme !== initTheme) {
      if (!themeChangePromise) {
        themeChangePromise = (async () => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'loose',
            theme: mermaidTheme as Parameters<typeof mermaid.initialize>[0]['theme'],
            htmlLabels: true,
            flowchart: FLOWCHART_CONFIG,
          });
          initTheme = mermaidTheme;
          themeChangePromise = null;
        })();
      }
      await themeChangePromise;
    }

    const id = `mermaid-svg-${++renderCounter}`;
    const { svg } = await mermaid.render(id, source.trim());
    return { svg };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Quick check if clean markdown contains any mermaid fenced code blocks */
export function hasMermaidBlocks(markdown: string): boolean {
  return /^```mermaid\s*$/m.test(markdown);
}
