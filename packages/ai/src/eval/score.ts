import type { Diagnosis } from '@vdeploy/contracts';
import { BANNED, type Scenario } from './scenarios.js';

/** What one scenario scored, and why — a failed run has to be readable. */
export interface Scored {
  id: string;
  /** The cause was named, not the symptom. */
  cause: boolean;
  /** How sure the answer claims to be matches how sure it should be. */
  confidence: boolean;
  /** Every fact a person needs is in the words (the port, the setting's name…). */
  facts: boolean;
  /** No symptom-speak and no jargon (§32 rule 1). */
  plain: boolean;
  /** The change it prepared is the one the scenario expects (null: none expected). */
  fix: boolean;
  notes: string[];
}

export function points(row: Scored): number {
  return [row.cause, row.confidence, row.facts, row.plain, row.fix].filter(Boolean).length;
}

export const MAX_POINTS = 5;

function missingWords(text: string, mentions: RegExp[]): RegExp[] {
  return mentions.filter((pattern) => !pattern.test(text));
}

function symptomSpeak(text: string): RegExp[] {
  return BANNED.filter((pattern) => pattern.test(text));
}

/**
 * Scores the deterministic layer alone (§32): what VDeploy says with no
 * model at all. This is the floor the assistant builds on, and it has to
 * hold on its own — the AI being off is not an outage.
 */
export function scoreRules(scenario: Scenario, diagnoses: Diagnosis[]): Scored {
  const notes: string[] = [];
  const found = diagnoses.find((d) => d.condition === scenario.expect.condition);
  if (!found) {
    notes.push(
      `named ${diagnoses.map((d) => d.condition).join(', ') || 'nothing'}, expected ${scenario.expect.condition}`,
    );
  }
  const words = found ? `${found.plain} ${found.fix} ${found.detected}` : '';
  const missing = found ? missingWords(words, scenario.expect.mentions) : scenario.expect.mentions;
  if (missing.length) notes.push(`does not say: ${missing.map(String).join(', ')}`);
  const banned = symptomSpeak(words);
  if (banned.length) notes.push(`symptom, not cause: ${banned.map(String).join(', ')}`);
  const confidence = found?.confidence === scenario.expect.confidence;
  if (found && !confidence) {
    notes.push(`confidence ${found.confidence}, expected ${scenario.expect.confidence}`);
  }
  return {
    id: scenario.id,
    cause: Boolean(found),
    confidence,
    facts: Boolean(found) && missing.length === 0,
    plain: banned.length === 0 && Boolean(found?.fix),
    // The rules do not prepare changes; only the assistant does.
    fix: true,
    notes,
  };
}

export interface AssistantRun {
  /** What it said, in the words the person reads. */
  text: string;
  /** The operations it prepared for approval. */
  proposed: string[];
}

/** Scores the assistant's own answer for one scenario. */
export function scoreAssistant(scenario: Scenario, run: AssistantRun): Scored {
  const notes: string[] = [];
  const missing = missingWords(run.text, scenario.expect.mentions);
  if (missing.length) notes.push(`does not say: ${missing.map(String).join(', ')}`);
  const banned = symptomSpeak(run.text);
  if (banned.length) notes.push(`symptom, not cause: ${banned.map(String).join(', ')}`);
  const wanted = scenario.expect.fixOperation;
  const fix = wanted === null ? run.proposed.length === 0 : run.proposed.includes(wanted);
  if (!fix) {
    notes.push(
      wanted === null
        ? `changed ${run.proposed.join(', ')} when nothing here needs changing`
        : `prepared ${run.proposed.join(', ') || 'nothing'}, expected ${wanted}`,
    );
  }
  // The assistant states the cause in its own words; the rules' condition name never appears.
  const cause = missing.length === 0 && banned.length === 0;
  return {
    id: scenario.id,
    cause,
    confidence: true,
    facts: missing.length === 0,
    plain: banned.length === 0,
    fix,
    notes,
  };
}

/** A scorecard a person can read at a glance, and act on when it drops. */
export function scorecard(title: string, rows: Scored[]): string {
  const scored = rows.reduce((sum, row) => sum + points(row), 0);
  const total = rows.length * MAX_POINTS;
  const percent = total === 0 ? 0 : Math.round((scored / total) * 100);
  const lines = rows.map((row) => {
    const mark = points(row) === MAX_POINTS ? 'ok  ' : 'FAIL';
    const why = row.notes.length ? ` — ${row.notes.join('; ')}` : '';
    return `  ${mark} ${row.id} ${String(points(row))}/${String(MAX_POINTS)}${why}`;
  });
  return [`${title}: ${String(scored)}/${String(total)} (${String(percent)}%)`, ...lines].join(
    '\n',
  );
}
