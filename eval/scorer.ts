import { parseComments, detectMissingAnchors } from '../src/lib/comment-parser.js';
import { getEffectiveStatus } from '../src/types.js';
import type {
  ExpectedCriteria,
  ScoringResult,
  DimensionScores,
  CommentExpectation,
  MarkerMode,
  MarkerDisposition,
} from './types.js';

// Regex with capture group for JSON parsing — different from the shared COMMENT_MARKER_RE
const COMMENT_MARKER_RE = /<!-- @comment(\{.*?\}) -->/gs;

const WEIGHTS: Record<keyof DimensionScores, number> = {
  parsing: 0.2,
  execution: 0.4,
  integrity: 0.2,
  anchorIntegrity: 0.2,
};

/**
 * The disposition a comment's marker should end in. The case-level markerMode
 * sets the default; a comment can override it, which is how a question inside
 * a remove-mode case expects to keep its marker.
 */
function dispositionFor(exp: CommentExpectation, markerMode: MarkerMode): MarkerDisposition {
  return exp.expectedMarker ?? (markerMode === 'remove' ? 'removed' : 'resolved');
}

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
    const actionable = expected.comments.filter((c) => c.expectedAction === 'address');
    if (
      expected.actionableComments !== undefined &&
      actionable.length !== expected.actionableComments
    ) {
      details.push(
        `warning: actionableComments (${expected.actionableComments}) does not match computed count (${actionable.length})`,
      );
    }
    const markerMode = expected.markerMode ?? 'remove';
    let correct = 0;
    for (const exp of actionable) {
      const survivor = outputById.get(exp.id);
      const disposition = dispositionFor(exp, markerMode);
      if (disposition === 'removed') {
        if (!survivor) {
          correct++;
          details.push(`parsing: ${exp.id} — marker correctly removed`);
        } else {
          details.push(`parsing: ${exp.id} — marker should have been removed but was preserved`);
        }
        continue;
      }
      if (!survivor) {
        details.push(`parsing: ${exp.id} — marker was deleted but should have been ${disposition}`);
        continue;
      }
      const hasReply = (survivor.replies?.length ?? 0) > 0;
      if (disposition === 'answered') {
        // A question. The reply IS the answer, so the marker has to survive
        // carrying it; no status is required, since both modes leave a
        // question open.
        if (hasReply) {
          correct++;
          details.push(`parsing: ${exp.id} — question answered, marker kept`);
        } else {
          details.push(`parsing: ${exp.id} — marker kept but the question was never answered`);
        }
        continue;
      }
      const isResolved = getEffectiveStatus(survivor) === 'resolved';
      if (isResolved && hasReply) {
        correct++;
        details.push(`parsing: ${exp.id} — marker resolved with a reply`);
      } else {
        const missing = [!isResolved && 'not resolved', !hasReply && 'no reply added']
          .filter(Boolean)
          .join(', ');
        details.push(`parsing: ${exp.id} — marker preserved but ${missing}`);
      }
    }
    parsingScore = actionable.length > 0 ? correct / actionable.length : 1.0;
    details.push(
      `parsing: ${correct}/${actionable.length} markers correctly handled (${markerMode})`,
    );
  }

  // --- 2. Execution: Did content changes address the feedback? ---
  let executionScore: number;
  if (!expected.contentShouldChange) {
    // Content should NOT have changed
    const unchanged = inputParsed.cleanMarkdown.trim() === outputParsed.cleanMarkdown.trim();
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
      if (exp.expectedAction === 'skip') continue;
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
      const changed = inputParsed.cleanMarkdown.trim() !== outputParsed.cleanMarkdown.trim();
      executionScore = changed ? 1.0 : 0.0;
      details.push(`execution: content should change — ${changed ? 'pass' : 'FAIL'}`);
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
          details.push(`integrity: marker missing essential fields (id/anchor/text)`);
        }
      } catch {
        details.push(`integrity: malformed JSON in marker`);
      }
    }
    integrityScore = valid / rawMarkers.length;
    details.push(`integrity: ${valid}/${rawMarkers.length} markers valid`);
  }

  // --- 4. Anchor integrity: do surviving markers still point at real text? ---
  // Scored on the agent's own output, with resolved comments included: an
  // agent that resolves a comment and rewrites its anchor text in the same
  // pass has still detached it.
  //
  // Half credit where md-redline recovered the anchor from the marker's
  // position. Recovery is the app's safety net, not the agent doing its job:
  // scoring it as a pass would let an agent rewrite every anchor in the file
  // and still come out clean, and scoring it as a failure would not
  // distinguish it from a marker stranded with nothing to point at.
  const RECOVERED_CREDIT = 0.5;
  let anchorScore: number | null;
  const survivors = outputParsed.comments;
  // In resolve mode the markers are SUPPOSED to survive, so a deleted one is
  // scored as detached rather than dropped from the denominator. Otherwise the
  // worst possible anchor outcome — delete every marker, taking every anchor
  // with it — is the one outcome this dimension cannot punish.
  const expectedSurvivorIds = expected.comments
    .filter(
      (c) =>
        c.expectedAction === 'address' &&
        dispositionFor(c, expected.markerMode ?? 'remove') !== 'removed',
    )
    .map((c) => c.id);
  const missingSurvivors = expectedSurvivorIds.filter((id) => !outputById.has(id));
  const denominator = survivors.length + missingSurvivors.length;

  if (denominator === 0) {
    // Not applicable rather than perfect. A remove-mode case ends with no
    // markers by design, so there is no anchor to keep or lose — awarding 1.0
    // would be a constant fifth of the score that measures nothing, dilute the
    // dimensions that do, and make every pre-existing result incomparable.
    // Null drops it and renormalizes the rest to their original proportions.
    anchorScore = null;
    details.push('anchorIntegrity: n/a (no markers expected to survive)');
  } else {
    const detached = detectMissingAnchors(outputParsed.cleanMarkdown, survivors, {
      includeResolved: true,
    });
    let credit = 0;
    let intact = 0;
    let recoveredCount = 0;
    for (const c of survivors) {
      // An empty anchor matches everything by construction (no parts to
      // locate), so presence alone would hand out full credit for erasing the
      // field. Nothing can be re-anchored to nothing.
      if (detached.has(c.id) || c.anchor.trim() === '') {
        details.push(
          `anchorIntegrity: ${c.id} — anchor "${trunc(c.anchor)}" no longer locatable in document`,
        );
      } else if (c.recoveredAnchor) {
        recoveredCount++;
        credit += RECOVERED_CREDIT;
        details.push(
          `anchorIntegrity: ${c.id} — anchor rewritten without updating the marker, recovered by position to "${trunc(c.recoveredAnchor)}"`,
        );
      } else {
        intact++;
        credit += 1;
      }
    }
    for (const id of missingSurvivors) {
      details.push(`anchorIntegrity: ${id} — marker deleted, taking its anchor with it`);
    }
    anchorScore = credit / denominator;
    details.push(
      `anchorIntegrity: ${intact} intact, ${recoveredCount} recovered by position, ${denominator - intact - recoveredCount} detached (of ${denominator})`,
    );
  }

  const scores: DimensionScores = {
    parsing: parsingScore,
    execution: executionScore,
    integrity: integrityScore,
    anchorIntegrity: anchorScore,
  };

  // Renormalize over the dimensions that apply, so a case with no anchor
  // surface is scored out of the three that do at their original relative
  // weights (0.25 / 0.50 / 0.25) rather than being handed a free fifth.
  const applicable = Object.entries(WEIGHTS).filter(
    ([key]) => scores[key as keyof DimensionScores] !== null,
  );
  const totalWeight = applicable.reduce((sum, [, weight]) => sum + weight, 0);
  const overall = applicable.reduce(
    (sum, [key, weight]) => sum + scores[key as keyof DimensionScores]! * (weight / totalWeight),
    0,
  );

  return { case: caseName, scores, overall, details };
}

function trunc(s: string, max = 40): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
