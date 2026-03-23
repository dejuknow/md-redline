export interface EvalCase {
  name: string;
  inputPath: string;
  promptPath: string;
  expectedPath: string;
}

export interface CommentExpectation {
  id: string;
  /** What the agent should do with this comment */
  expectedAction: 'address' | 'skip';
  /** Content assertions near the anchor after the agent acts */
  contentHints?: {
    shouldContain?: string[];
    shouldNotContain?: string[];
  };
}

export interface ContentAssertion {
  type: 'contains' | 'not_contains';
  value: string;
}

export interface ExpectedCriteria {
  totalComments: number;
  actionableComments: number;
  skipComments: number;
  comments: CommentExpectation[];
  contentShouldChange: boolean;
  contentAssertions?: ContentAssertion[];
}

export interface DimensionScores {
  /** Did the agent preserve all markers as valid? (0-1) */
  parsing: number;
  /** Did it act on open and skip resolved? (0-1) */
  triage: number;
  /** Did the content changes address the feedback? (0-1) */
  execution: number;
  /** Did it set status to "addressed"? (0-1) */
  protocol: number;
  /** Are all markers still valid JSON after the agent touched the file? (0-1) */
  integrity: number;
}

export interface ScoringResult {
  case: string;
  scores: DimensionScores;
  overall: number;
  details: string[];
}

export interface AgentAdapter {
  name: string;
  run(inputPath: string, prompt: string): Promise<string>;
}

export interface FormatAdapter {
  name: string;
  /** Transform input from current format to this variant */
  toVariant(currentFormat: string): string;
  /** Transform agent output from this variant back to current format for scoring */
  fromVariant(variantFormat: string): string;
}
