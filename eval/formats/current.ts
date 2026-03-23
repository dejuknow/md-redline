import type { FormatAdapter } from '../types.js';

/** Current format — passthrough, no transformation needed */
export const currentFormat: FormatAdapter = {
  name: 'current',
  toVariant: (input) => input,
  fromVariant: (output) => output,
};
