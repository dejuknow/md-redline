export interface MdComment {
  id: string;
  anchor: string;
  text: string;
  author: string;
  timestamp: string;
  resolved: boolean;
  /** Character offset of the anchor's start position in the clean markdown. Computed at parse time, not stored in the file. */
  cleanOffset?: number;
}

export interface ParseResult {
  cleanMarkdown: string;
  comments: MdComment[];
  cleanToRawOffset: (cleanOffset: number) => number;
}

export interface SelectionInfo {
  text: string;
  rect: DOMRect;
  contextBefore: string;
  contextAfter: string;
}
