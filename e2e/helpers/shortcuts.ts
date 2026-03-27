export const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';
export const MOD_LABEL = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';

export function withMod(key: string): string {
  return `${MOD_KEY}+${key}`;
}
