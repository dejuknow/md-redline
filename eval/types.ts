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
  comments: CommentExpectation[];
  contentShouldChange: boolean;
  contentAssertions?: ContentAssertion[];
}

export interface DimensionScores {
  /** Did the agent preserve/remove markers correctly? (0-1) */
  parsing: number;
  /** Did the content changes address the feedback? (0-1) */
  execution: number;
  /** Are all remaining markers valid JSON? (0-1) */
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
