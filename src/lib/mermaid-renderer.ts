import DOMPurify from 'dompurify';

let mermaidModule: typeof import('mermaid') | null = null;
let initTheme: string | null = null;
let themeChangePromise: Promise<void> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();

const FLOWCHART_CONFIG = {
  useMaxWidth: true,
  wrappingWidth: 200,
  rankSpacing: 70,
} as const;

const VALID_MERMAID_THEMES = new Set(['default', 'dark', 'forest', 'neutral', 'base']);

async function getMermaid() {
  if (!mermaidModule) {
    mermaidModule = await import('mermaid');
    mermaidModule.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
      // Flowchart labels render as plain SVG <text> (not HTML inside
      // foreignObject) so they survive DOMPurify's strict SVG profile, which
      // strips foreignObject for XSS reasons. SVG <text> labels are styled
      // for comment highlights via applyMermaidSvgTextHighlight.
      htmlLabels: false,
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
  if (VALID_MERMAID_THEMES.has(appTheme)) return appTheme;
  return THEME_MAP[appTheme] || 'default';
}

let renderCounter = 0;

export async function renderMermaidBlock(
  source: string,
  appTheme: string,
): Promise<{ svg: string } | { error: string }> {
  const run = async (): Promise<{ svg: string } | { error: string }> => {
    try {
      const mermaid = await getMermaid();
      const mermaidTheme = getMermaidTheme(appTheme);

      // Serialize theme changes to avoid concurrent re-initialization races.
      // After awaiting a pending promise, re-check in case a newer theme was
      // requested while we were waiting (rapid toggling).
      while (mermaidTheme !== initTheme) {
        if (!themeChangePromise) {
          const currentThemeChange = Promise.resolve().then(() => {
            mermaid.initialize({
              startOnLoad: false,
              securityLevel: 'strict',
              theme: mermaidTheme as Parameters<typeof mermaid.initialize>[0]['theme'],
              htmlLabels: false,
              flowchart: FLOWCHART_CONFIG,
            });
            initTheme = mermaidTheme;
          });
          const wrappedThemeChange = currentThemeChange.finally(() => {
            if (themeChangePromise === wrappedThemeChange) {
              themeChangePromise = null;
            }
          });
          themeChangePromise = wrappedThemeChange;
        }
        await themeChangePromise;
      }

      const id = `mermaid-svg-${++renderCounter}`;
      const { svg } = await mermaid.render(id, source.trim());
      // Mermaid emits sequence-diagram actor labels with `alignment-baseline`
      // on <text>, but per SVG spec that attribute only applies to <tspan>
      // and friends. Chrome ignores it on <text>, so the labels render below
      // the geometric centre of their boxes. Replace with `dominant-baseline`
      // (which Chrome honours on <text>) so labels are vertically centred.
      const baselineFixed = svg.replace(/\salignment-baseline=/g, ' dominant-baseline=');
      const cleanSvg = DOMPurify.sanitize(baselineFixed, {
        USE_PROFILES: { html: true, svg: true, svgFilters: true },
        // DOMPurify's SVG profile strips dominant-baseline by default; we need
        // it to vertically centre actor labels in sequence diagrams.
        ADD_ATTR: ['dominant-baseline'],
      });
      return { svg: cleanSvg };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

  const queuedRender = renderQueue.then(run, run);
  renderQueue = queuedRender.then(
    () => undefined,
    () => undefined,
  );
  return queuedRender;
}

/** Quick check if clean markdown contains any mermaid fenced code blocks */
export function hasMermaidBlocks(markdown: string): boolean {
  return /^```mermaid\s*$/m.test(markdown);
}
