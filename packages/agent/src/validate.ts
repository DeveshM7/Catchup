import type { AreasOutput, FlowOutput, LabelsOutput } from "./schemas.js";

const MAX_STEPS = 8;
const MIN_STEPS = 4;

export type FlowCheck = {
  /** Every function ID allowed in this flow (the whole tree). */
  allowed: Set<string>;
  /** Function IDs that must appear in some step. */
  mustCover: string[];
  /** Step IDs from the previous version that may be reused. */
  previousIds: Set<string>;
  /** Previous step IDs whose functions didn't change: they must be returned. */
  keepIds: Set<string>;
};

/** Problems with Claude's flow; empty when it can be stored (ARCHITECTURE §5). */
export function validateFlow(output: FlowOutput, check: FlowCheck): string[] {
  const errors: string[] = [];
  const min = Math.min(MIN_STEPS, check.allowed.size);
  if (output.steps.length < min || output.steps.length > MAX_STEPS) {
    errors.push(`expected ${min}–${MAX_STEPS} steps, got ${output.steps.length}`);
  }
  const covered = new Set<string>();
  const ids = new Set<string>();
  output.steps.forEach((step, i) => {
    const name = `step ${i + 1} ("${step.label}")`;
    if (step.functions.length === 0) errors.push(`${name} lists no functions`);
    for (const fn of step.functions) {
      if (check.allowed.has(fn)) covered.add(fn);
      else errors.push(`${name} cites "${fn}", which is not a function in this flow`);
    }
    if (step.id !== null) {
      if (!check.previousIds.has(step.id)) errors.push(`${name} has id "${step.id}", which is not a previous step id (use null for new steps)`);
      if (ids.has(step.id)) errors.push(`step id "${step.id}" is used twice`);
      ids.add(step.id);
    }
  });
  const missing = check.mustCover.filter((fn) => !covered.has(fn));
  if (missing.length > 0) errors.push(`these important functions are in no step: ${missing.join(", ")}`);
  for (const id of check.keepIds) if (!ids.has(id)) errors.push(`unchanged step "${id}" must be kept (return it with its id)`);
  return errors;
}

export function validateLabels(output: LabelsOutput, expected: string[]): string[] {
  const errors: string[] = [];
  const got = new Set<string>();
  for (const label of output.labels) {
    if (!expected.includes(label.id)) errors.push(`unknown component "${label.id}"`);
    if (got.has(label.id)) errors.push(`component "${label.id}" labeled twice`);
    got.add(label.id);
  }
  const missing = expected.filter((id) => !got.has(id));
  if (missing.length > 0) errors.push(`missing labels for: ${missing.join(", ")}`);
  return errors;
}

export function validateAreas(output: AreasOutput, flowIds: string[]): string[] {
  const errors: string[] = [];
  const max = 7;
  const min = Math.min(3, flowIds.length);
  if (output.areas.length < min || output.areas.length > max) errors.push(`expected ${min}–${max} areas, got ${output.areas.length}`);
  const seen = new Map<string, string>();
  const areaIds = new Set<string>();
  for (const area of output.areas) {
    if (areaIds.has(area.id)) errors.push(`area id "${area.id}" is used twice`);
    areaIds.add(area.id);
    for (const flow of area.flows) {
      if (!flowIds.includes(flow)) errors.push(`area "${area.id}" lists unknown flow "${flow}"`);
      const other = seen.get(flow);
      if (other !== undefined) errors.push(`flow "${flow}" is in both "${other}" and "${area.id}"`);
      seen.set(flow, area.id);
    }
  }
  const missing = flowIds.filter((id) => !seen.has(id));
  if (missing.length > 0) errors.push(`flows in no area: ${missing.join(", ")}`);
  return errors;
}
