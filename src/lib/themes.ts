export interface ThemeDef {
  key: string;
  label: string;
  colors: [string, string, string];
}

export const LIGHT_THEMES: ThemeDef[] = [
  { key: 'light', label: 'Light', colors: ['#ffffff', '#4f46e5', '#f59e0b'] },
  { key: 'sepia', label: 'Sepia', colors: ['#faf6f1', '#8b5e3c', '#d4a04a'] },
  { key: 'solarized', label: 'Solarized', colors: ['#fdf6e3', '#268bd2', '#b58900'] },
  { key: 'github', label: 'GitHub', colors: ['#ffffff', '#0969da', '#bf8700'] },
];

export const DARK_THEMES: ThemeDef[] = [
  { key: 'dark', label: 'Dark', colors: ['#0f172a', '#818cf8', '#f59e0b'] },
  { key: 'nord', label: 'Nord', colors: ['#2e3440', '#88c0d0', '#ebcb8b'] },
  { key: 'rose-pine', label: 'Rosé Pine', colors: ['#191724', '#c4a7e7', '#f6c177'] },
  { key: 'catppuccin', label: 'Catppuccin', colors: ['#1e1e2e', '#cba6f7', '#f9e2af'] },
];

export const ALL_THEMES: ThemeDef[] = [...LIGHT_THEMES, ...DARK_THEMES];
