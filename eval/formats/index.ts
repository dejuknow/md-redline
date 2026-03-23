import type { FormatAdapter } from '../types.js';
import { currentFormat } from './current.js';

const formats: Record<string, FormatAdapter> = {
  current: currentFormat,
};

export function getFormat(name: string): FormatAdapter {
  const format = formats[name];
  if (!format) {
    throw new Error(
      `Unknown format: ${name}. Available: ${Object.keys(formats).join(', ')}`,
    );
  }
  return format;
}

export function listFormats(): string[] {
  return Object.keys(formats);
}
