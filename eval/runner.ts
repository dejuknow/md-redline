import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { score } from './scorer.js';
import { getFormat } from './formats/index.js';
import { claudeCli } from './agents/claude-cli.js';
import type { AgentAdapter, EvalCase, ExpectedCriteria, ScoringResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');
const RESULTS_DIR = join(__dirname, 'results');

const agents: Record<string, AgentAdapter> = {
  'claude-cli': claudeCli,
};

async function discoverCases(filter?: string): Promise<EvalCase[]> {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const cases: EvalCase[] = [];
  for (const name of dirs) {
    if (filter && !name.includes(filter)) continue;
    const dir = join(FIXTURES_DIR, name);
    cases.push({
      name,
      inputPath: join(dir, 'input.md'),
      promptPath: join(dir, 'prompt.txt'),
      expectedPath: join(dir, 'expected.json'),
    });
  }
  return cases;
}

async function runCase(
  evalCase: EvalCase,
  agent: AgentAdapter,
  formatName: string,
): Promise<ScoringResult> {
  const format = getFormat(formatName);

  const inputRaw = await readFile(evalCase.inputPath, 'utf-8');
  const prompt = await readFile(evalCase.promptPath, 'utf-8');
  const expected: ExpectedCriteria = JSON.parse(
    await readFile(evalCase.expectedPath, 'utf-8'),
  );

  // Transform input to the target format variant
  const inputVariant = format.toVariant(inputRaw);

  // Write the transformed input to a temp location and run the agent
  const { tmpdir } = await import('node:os');
  const { mkdtemp, writeFile: writeTmp, rm } = await import('node:fs/promises');
  const tempDir = await mkdtemp(join(tmpdir(), 'md-eval-input-'));
  const tempInput = join(tempDir, 'input.md');
  await writeTmp(tempInput, inputVariant);

  let outputVariant: string;
  try {
    outputVariant = await agent.run(tempInput, prompt);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  // Transform output back to current format for scoring
  const outputRaw = format.fromVariant(outputVariant);

  return score(evalCase.name, inputRaw, outputRaw, expected);
}

function printTable(results: ScoringResult[]) {
  const header = [
    'Case'.padEnd(28),
    'Parse',
    ' Exec',
    'Integ',
    'Overall',
  ].join(' | ');

  const divider = '-'.repeat(header.length);

  console.log('\n' + divider);
  console.log(header);
  console.log(divider);

  for (const r of results) {
    const row = [
      r.case.padEnd(28),
      fmtPct(r.scores.parsing),
      fmtPct(r.scores.execution),
      fmtPct(r.scores.integrity),
      fmtPct(r.overall),
    ].join(' | ');
    console.log(row);
  }

  console.log(divider);

  // Averages
  if (results.length > 1) {
    const avg = (key: keyof ScoringResult['scores']) =>
      results.reduce((s, r) => s + r.scores[key], 0) / results.length;
    const avgOverall =
      results.reduce((s, r) => s + r.overall, 0) / results.length;
    const row = [
      'AVERAGE'.padEnd(28),
      fmtPct(avg('parsing')),
      fmtPct(avg('execution')),
      fmtPct(avg('integrity')),
      fmtPct(avgOverall),
    ].join(' | ');
    console.log(row);
    console.log(divider);
  }
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(0).padStart(5) + '%';
}

async function validateFixtures(cases: EvalCase[]) {
  let valid = true;
  for (const c of cases) {
    const errors: string[] = [];
    try {
      await readFile(c.inputPath, 'utf-8');
    } catch {
      errors.push('missing input.md');
    }
    try {
      await readFile(c.promptPath, 'utf-8');
    } catch {
      errors.push('missing prompt.txt');
    }
    try {
      const raw = await readFile(c.expectedPath, 'utf-8');
      JSON.parse(raw);
    } catch {
      errors.push('missing or invalid expected.json');
    }
    if (errors.length) {
      console.error(`  INVALID: ${c.name} — ${errors.join(', ')}`);
      valid = false;
    } else {
      console.log(`  OK: ${c.name}`);
    }
  }
  return valid;
}

async function main() {
  const { values } = parseArgs({
    options: {
      case: { type: 'string', short: 'c' },
      format: { type: 'string', short: 'f', default: 'current' },
      agent: { type: 'string', short: 'a', default: 'claude-cli' },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
    },
    strict: true,
  });

  const cases = await discoverCases(values.case);
  if (cases.length === 0) {
    console.error('No matching cases found.');
    process.exit(1);
  }

  console.log(`Found ${cases.length} case(s)\n`);

  // Validate fixtures
  console.log('Validating fixtures...');
  const valid = await validateFixtures(cases);
  if (!valid) {
    console.error('\nFixture validation failed.');
    process.exit(1);
  }

  if (values['dry-run']) {
    console.log('\nDry run complete — all fixtures valid.');
    return;
  }

  const agentName = values.agent!;
  const agent = agents[agentName];
  if (!agent) {
    console.error(
      `Unknown agent: ${agentName}. Available: ${Object.keys(agents).join(', ')}`,
    );
    process.exit(1);
  }

  const formatName = values.format!;
  console.log(`\nRunning with agent="${agentName}", format="${formatName}"\n`);

  // Create results directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = join(RESULTS_DIR, `${timestamp}_${agentName}_${formatName}`);
  await mkdir(runDir, { recursive: true });

  const results: ScoringResult[] = [];

  for (const evalCase of cases) {
    process.stdout.write(`Running: ${evalCase.name}...`);
    try {
      const result = await runCase(evalCase, agent, formatName);
      results.push(result);
      console.log(` done (overall: ${(result.overall * 100).toFixed(0)}%)`);

      // Save per-case results
      const caseDir = join(runDir, evalCase.name);
      await mkdir(caseDir, { recursive: true });
      await writeFile(
        join(caseDir, 'scores.json'),
        JSON.stringify(result, null, 2),
      );

      if (values.verbose) {
        for (const d of result.details) {
          console.log(`    ${d}`);
        }
      }
    } catch (err) {
      console.log(` FAILED`);
      const errorResult: ScoringResult = {
        case: evalCase.name,
        scores: {
          parsing: 0,
          execution: 0,
          integrity: 0,
        },
        overall: 0,
        details: [`error: ${err instanceof Error ? err.message : String(err)}`],
      };
      results.push(errorResult);

      const caseDir = join(runDir, evalCase.name);
      await mkdir(caseDir, { recursive: true });
      await writeFile(
        join(caseDir, 'scores.json'),
        JSON.stringify(errorResult, null, 2),
      );
    }
  }

  // Print summary table
  printTable(results);

  // Save summary
  const summary = {
    timestamp,
    agent: agentName,
    format: formatName,
    cases: results.length,
    averageOverall:
      results.reduce((s, r) => s + r.overall, 0) / results.length,
    results,
  };
  await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nResults saved to: ${runDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
