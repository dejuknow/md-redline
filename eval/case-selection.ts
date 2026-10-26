import type { MarkerMode } from './types.js';

export type SkipDecision =
  | { skip: false }
  | { skip: true; reason: 'agent'; message: string }
  | { skip: true; reason: 'mode'; message: string };

/**
 * Whether a case should be scored by the selected agent.
 *
 * Two rules, and they are not the same thing:
 *
 * `requiresAgent` pins a case to ONE adapter. Use it when the case exists to
 * measure a specific adapter's instructions rather than a mode: 17 must run
 * against `claude-cli-remove` because `claude-cli` shares its mode but carries
 * a frozen preamble that fails the case by design.
 *
 * `markerMode` is the general rule. A remove-mode case scored by a resolve-mode
 * agent fails every marker by construction, since the agent was told to resolve
 * them and the case expects them gone. That is not a measurement, and averaged
 * across a suite it buries real movement: running the resolve agent over the
 * whole set reported 79% overall, of which 15 cases were failing for no reason
 * except that they were asked the wrong question.
 */
export function decideSkip(input: {
  caseName: string;
  caseMode: MarkerMode | undefined;
  requiresAgent: string | undefined;
  agentName: string;
  agentMode: MarkerMode;
}): SkipDecision {
  const { caseName, requiresAgent, agentName, agentMode } = input;
  const caseMode: MarkerMode = input.caseMode ?? 'remove';

  if (requiresAgent && requiresAgent !== agentName) {
    return {
      skip: true,
      reason: 'agent',
      message: `${caseName} — needs agent "${requiresAgent}", running "${agentName}"`,
    };
  }
  if (caseMode !== agentMode) {
    return {
      skip: true,
      reason: 'mode',
      message: `${caseName} — ${caseMode}-mode case, agent "${agentName}" is ${agentMode}-mode`,
    };
  }
  return { skip: false };
}

const MARKER_MODES: readonly MarkerMode[] = ['remove', 'resolve'];

/**
 * What is wrong with an expected.json's case-selection fields, if anything.
 * Either field misspelled makes `decideSkip` skip the case under every agent,
 * forever, with one log line per run and no failure anywhere (#105), so
 * `eval:dry`, which CI runs, rejects them instead.
 */
export function selectionProblems(
  expected: { markerMode?: unknown; requiresAgent?: unknown },
  knownAgents: readonly string[],
): string[] {
  const problems: string[] = [];
  const { markerMode, requiresAgent } = expected;
  if (markerMode !== undefined && !MARKER_MODES.includes(markerMode as MarkerMode)) {
    problems.push(`markerMode "${String(markerMode)}" is not one of ${MARKER_MODES.join(', ')}`);
  }
  if (requiresAgent !== undefined && !knownAgents.includes(requiresAgent as string)) {
    problems.push(
      `requiresAgent "${String(requiresAgent)}" is not a known agent (${knownAgents.join(', ')})`,
    );
  }
  return problems;
}
