import { parseComments } from '../src/lib/comment-parser.js';
import type { ExpectedCriteria, ScoringResult, DimensionScores } from './types.js';

const COMMENT_MARKER_RE = /<!-- @comment(\{.*?\}) -->/gs;

const WEIGHTS: Record<keyof DimensionScores, number> = {
  parsing: 0.15,
  triage: 0.20,
  execution: 0.30,
  protocol: 0.20,
  integrity: 0.15,
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

  const inputById = new Map(inputParsed.comments.map((c) => [c.id, c]));
  const outputById = new Map(outputParsed.comments.map((c) => [c.id, c]));

  // --- 1. Parsing: Are all input markers still present and parseable? ---
  let parsingScore: number;
  if (expected.totalComments === 0) {
    parsingScore = 1.0;
    details.push('parsing: no comments expected, score=1.0');
  } else {
    // Count how many input comment IDs are still found in output
    let preserved = 0;
    for (const id of inputById.keys()) {
      if (outputById.has(id)) preserved++;
    }
    parsingScore = preserved / inputById.size;
    details.push(
      `parsing: ${preserved}/${inputById.size} markers preserved`,
    );
  }

  // --- 2. Triage: Did it act on actionable and skip non-actionable? ---
  let triageScore: number;
  if (expected.comments.length === 0) {
    triageScore = 1.0;
    details.push('triage: no comments to triage, score=1.0');
  } else {
    let correct = 0;
    for (const exp of expected.comments) {
      const inputComment = inputById.get(exp.id);
      const outputComment = outputById.get(exp.id);

      if (exp.expectedAction === 'address') {
        // Should have been acted on: status changed, or content near anchor modified, or marker removed
        const statusChanged =
          outputComment && outputComment.status !== inputComment?.status;
        const markerRemoved = !outputComment;
        const contentChanged =
          inputParsed.cleanMarkdown !== outputParsed.cleanMarkdown;

        if (statusChanged || markerRemoved || contentChanged) {
          correct++;
          details.push(`triage: ${exp.id} — correctly acted on`);
        } else {
          details.push(`triage: ${exp.id} — should have been addressed but wasn't`);
        }
      } else if (exp.expectedAction === 'skip') {
        // Should have been left alone
        if (outputComment) {
          const statusUnchanged =
            outputComment.status === inputComment?.status &&
            outputComment.resolved === inputComment?.resolved;
          if (statusUnchanged) {
            correct++;
            details.push(`triage: ${exp.id} — correctly skipped`);
          } else {
            details.push(`triage: ${exp.id} — should have been skipped but was modified`);
          }
        } else {
          details.push(`triage: ${exp.id} — should have been skipped but was removed`);
        }
      }
    }
    triageScore = correct / expected.comments.length;
    details.push(
      `triage: ${correct}/${expected.comments.length} correct`,
    );
  }

  // --- 3. Execution: Did content changes address the feedback? ---
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

  // --- 4. Protocol: Did it set status to "addressed"? ---
  let protocolScore: number;
  const addressable = expected.comments.filter(
    (c) => c.expectedAction === 'address',
  );
  if (addressable.length === 0) {
    protocolScore = 1.0;
    details.push('protocol: no comments to address, score=1.0');
  } else {
    let correct = 0;
    for (const exp of addressable) {
      const outputComment = outputById.get(exp.id);
      if (outputComment) {
        // Check if status was set to "addressed"
        const rawStatus = (outputComment as Record<string, unknown>).status;
        if (rawStatus === 'addressed') {
          correct++;
          details.push(`protocol: ${exp.id} — status correctly set to "addressed"`);
        } else {
          details.push(
            `protocol: ${exp.id} — status is "${rawStatus}" (expected "addressed")`,
          );
        }
      } else {
        // Marker was removed — partial credit (agent addressed it but didn't follow protocol)
        correct += 0.5;
        details.push(
          `protocol: ${exp.id} — marker removed (partial credit)`,
        );
      }
    }
    protocolScore = correct / addressable.length;
    details.push(
      `protocol: ${correct}/${addressable.length} correct`,
    );
  }

  // --- 5. Integrity: Are all markers in the output valid JSON? ---
  let integrityScore: number;
  const rawMarkers = [...outputRaw.matchAll(new RegExp(COMMENT_MARKER_RE))];
  if (rawMarkers.length === 0 && expected.totalComments === 0) {
    integrityScore = 1.0;
    details.push('integrity: no markers expected or found, score=1.0');
  } else if (rawMarkers.length === 0 && expected.totalComments > 0) {
    integrityScore = 0.0;
    details.push('integrity: all markers were removed — FAIL');
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
    triage: triageScore,
    execution: executionScore,
    protocol: protocolScore,
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
