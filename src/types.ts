export interface MdComment {
  id: string;
  anchor: string;
  text: string;
  author: string;
  timestamp: string;
  resolved: boolean;
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
