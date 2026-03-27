import { parseComments } from '../src/lib/comment-parser.js';
import type { ExpectedCriteria, ScoringResult, DimensionScores } from './types.js';

const COMMENT_MARKER_RE = /<!-- @comment(\{.*?\}) -->/gs;

const WEIGHTS: Record<keyof DimensionScores, number> = {
  parsing: 0.25,
  execution: 0.50,
  integrity: 0.25,
};

export function score(
  caseName: string,
  inputRaw: string,
  outputRaw: string,
  expected: ExpectedCriteria,
): ScoringResult {
  const details: string[] = [];

  const inputParsed = parseComments(inputRaw);
  const outputParsed = parseComments(outputRaw);

  const outputById = new Map(outputParsed.comments.map((c) => [c.id, c]));

  // --- 1. Parsing: Were comment markers handled correctly? ---
  // After addressing, agents should DELETE markers. Score based on whether
  // addressed comments had their markers removed.
  let parsingScore: number;
  if (expected.totalComments === 0) {
    parsingScore = 1.0;
    details.push('parsing: no comments expected, score=1.0');
  } else {
    let correct = 0;
    for (const exp of expected.comments) {
      if (exp.expectedAction === 'address') {
        // Marker should be removed after addressing
        if (!outputById.has(exp.id)) {
          correct++;
          details.push(`parsing: ${exp.id} — marker correctly removed`);
        } else {
          details.push(`parsing: ${exp.id} — marker should have been removed but was preserved`);
        }
      }
    }
    parsingScore = expected.comments.length > 0 ? correct / expected.comments.length : 1.0;
    details.push(
      `parsing: ${correct}/${expected.comments.length} markers correctly handled`,
    );
  }

  // --- 2. Execution: Did content changes address the feedback? ---
  let executionScore: number;
  if (!expected.contentShouldChange) {
    // Content should NOT have changed
    const unchanged =
      inputParsed.cleanMarkdown.trim() === outputParsed.cleanMarkdown.trim();
    executionScore = unchanged ? 1.0 : 0.0;
    details.push(
      `execution: content should be unchanged — ${unchanged ? 'pass' : 'FAIL (content was modified)'}`,
    );
  } else {
    // Check content assertions
    const assertions = expected.contentAssertions ?? [];
    // Also check per-comment content hints
    const allChecks: { pass: boolean; detail: string }[] = [];

    for (const assertion of assertions) {
      const found = outputParsed.cleanMarkdown.includes(assertion.value);
      if (assertion.type === 'contains') {
        allChecks.push({
          pass: found,
          detail: found
            ? `contains "${trunc(assertion.value)}" — pass`
            : `missing "${trunc(assertion.value)}" — FAIL`,
        });
      } else {
        allChecks.push({
          pass: !found,
          detail: !found
            ? `does not contain "${trunc(assertion.value)}" — pass`
            : `still contains "${trunc(assertion.value)}" — FAIL`,
        });
      }
    }

    for (const exp of expected.comments) {
      if (!exp.contentHints) continue;
      for (const s of exp.contentHints.shouldContain ?? []) {
        const found = outputParsed.cleanMarkdown.includes(s);
        allChecks.push({
          pass: found,
          detail: `${exp.id}: should contain "${trunc(s)}" — ${found ? 'pass' : 'FAIL'}`,
        });
      }
      for (const s of exp.contentHints.shouldNotContain ?? []) {
        const found = outputParsed.cleanMarkdown.includes(s);
        allChecks.push({
          pass: !found,
          detail: `${exp.id}: should not contain "${trunc(s)}" — ${!found ? 'pass' : 'FAIL'}`,
        });
      }
    }

    if (allChecks.length === 0) {
      // No specific assertions — just check that content changed at all
      const changed =
        inputParsed.cleanMarkdown.trim() !== outputParsed.cleanMarkdown.trim();
      executionScore = changed ? 1.0 : 0.0;
      details.push(
        `execution: content should change — ${changed ? 'pass' : 'FAIL'}`,
      );
    } else {
      const passed = allChecks.filter((c) => c.pass).length;
      executionScore = passed / allChecks.length;
      for (const c of allChecks) details.push(`execution: ${c.detail}`);
    }
  }

  // --- 3. Integrity: Are all remaining markers in the output valid JSON? ---
  let integrityScore: number;
  const rawMarkers = [...outputRaw.matchAll(new RegExp(COMMENT_MARKER_RE))];
  if (rawMarkers.length === 0) {
    integrityScore = 1.0;
    details.push('integrity: no markers remaining, score=1.0');
  } else {
    let valid = 0;
    for (const m of rawMarkers) {
      try {
        const data = JSON.parse(m[1]);
        // Check essential fields are present
        if (data.id && data.anchor !== undefined && data.text !== undefined) {
          valid++;
        } else {
          details.push(
            `integrity: marker missing essential fields (id/anchor/text)`,
          );
        }
      } catch {
        details.push(`integrity: malformed JSON in marker`);
      }
    }
    integrityScore = valid / rawMarkers.length;
    details.push(
      `integrity: ${valid}/${rawMarkers.length} markers valid`,
    );
  }

  const scores: DimensionScores = {
    parsing: parsingScore,
    execution: executionScore,
    integrity: integrityScore,
  };

  const overall = Object.entries(WEIGHTS).reduce(
    (sum, [key, weight]) => sum + scores[key as keyof DimensionScores] * weight,
    0,
  );

  return { case: caseName, scores, overall, details };
}

function trunc(s: string, max = 40): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
