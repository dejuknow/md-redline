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

/**
 * What the agent is expected to do with a marker once it has addressed the
 * comment. `remove` is the original hand-off contract; `resolve` is what the
 * app ships by default now, where the marker stays in the file carrying a
 * reply and a resolved status. Anchor drift only shows up under `resolve`,
 * since a removed marker takes its anchor with it.
 */
export type MarkerMode = 'remove' | 'resolve';

export interface ExpectedCriteria {
  /** Defaults to 'remove' when absent, so existing fixtures are unaffected. */
  markerMode?: MarkerMode;
  /**
   * Agent adapter this case needs to be meaningful. `markerMode` describes what
   * the OUTPUT should look like, but the mode the agent runs in comes from the
   * global `--agent` flag, so a resolve-mode case scored against a remove-mode
   * agent fails by construction AND reports a vacuous anchorIntegrity (no
   * markers survive, nothing to detach). The runner skips a case whose
   * requirement the selected agent does not meet rather than scoring it.
   */
  requiresAgent?: string;
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
  /**
   * Do the anchors on surviving markers still resolve against the document
   * the agent produced? (0-1) An agent that rewrites prose without updating
   * the anchors it rewrote scores full marks on every other dimension while
   * detaching the review from the document, which is what this measures.
   *
   * `null` when the case expects no markers to survive, so there is no anchor
   * to keep or lose. The overall score renormalizes over the dimensions that
   * apply rather than scoring an absent surface as perfect.
   */
  anchorIntegrity: number | null;
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
