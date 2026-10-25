import * as z from "zod/v4";

/** Stored explanation for one commit (D23). Claude writes the words; code owns IDs and references. */
export type Step = {
  id: string;
  label: string;
  summary: string;
  /** Function IDs from the facts, in this flow's call tree. */
  functions: string[];
  kind: StepKind;
};

export type StepKind = "main" | "error" | "branch";

export type Flow = {
  /** = entry point id */
  id: string;
  label: string;
  steps: Step[];
  partial: boolean;
  /** function id → body hash for every function in the tree when this flow was explained. */
  basis: Record<string, string>;
};

export type ComponentLabel = {
  id: string;
  name: string;
  description: string;
  /** Sorted file list the label was written for; a changed list re-labels. */
  basis: string;
};

export type Area = { id: string; name: string; description: string; flows: string[] };

/** A group of folders the main flows run through, named by Claude (D34). */
export type OverviewPart = { id: string; name: string; description: string; dirs: string[] };

/** One main flow as 3–5 short steps for the first screen (D34). */
export type OverviewFlow = {
  /** Entry point id of the family's representative. */
  entry: string;
  /** Flow family id (D32) and how many entry points it stands for. */
  family: string;
  members: number;
  title: string;
  steps: { text: string; functions: string[] }[];
};

/** The first screen (D31, D34). Claude writes the words; code picks the flows, folders, links and start file. */
export type Overview = {
  summary: string;
  parts: OverviewPart[];
  /** External systems the main flows use, by name. */
  systems: string[];
  /** Part → part and part → `system:<name>`, computed from the call trees. */
  links: { from: string; to: string }[];
  flows: OverviewFlow[];
  /** The file holding the top main flow's handler. */
  startHere: string;
  /** Hash of the prompt it was written from; same basis → copied without a Claude call (D4). */
  basis: string;
};

export type Explained = {
  sha: string;
  model: string;
  components: ComponentLabel[];
  flows: Flow[];
  areas: Area[];
  overview?: Overview;
};

const stepKind = z.enum(["main", "error", "branch"]);

/** What Claude returns for one flow. `id` is a previous step's id when revising it, else null. */
export const FlowOutput = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().nullable(),
        label: z.string().min(1),
        summary: z.string().min(1),
        functions: z.array(z.string()),
        kind: stepKind,
      }),
    )
    .min(1),
});
export type FlowOutput = z.infer<typeof FlowOutput>;

export const LabelsOutput = z.object({
  labels: z.array(z.object({ id: z.string(), name: z.string().min(1), description: z.string().min(1) })),
});
export type LabelsOutput = z.infer<typeof LabelsOutput>;

export const AreasOutput = z.object({
  areas: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
        name: z.string().min(1),
        description: z.string().min(1),
        flows: z.array(z.string()),
      }),
    )
    .min(1),
});
export type AreasOutput = z.infer<typeof AreasOutput>;

const kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const OverviewOutput = z.object({
  summary: z.string().min(1),
  parts: z
    .array(z.object({ id: kebab, name: z.string().min(1), description: z.string().min(1), dirs: z.array(z.string()).min(1) }))
    .min(1),
  flows: z.array(
    z.object({
      entry: z.string(),
      title: z.string().min(1),
      steps: z.array(z.object({ text: z.string().min(1), functions: z.array(z.string()) })).min(1),
    }),
  ),
});
export type OverviewOutput = z.infer<typeof OverviewOutput>;

/** Caption for a change between two snapshots (used in Phase 4). */
export const CaptionOutput = z.object({
  caption: z.string().min(1),
  impact: z.string().min(1),
  commits: z.array(z.string()),
});
export type CaptionOutput = z.infer<typeof CaptionOutput>;

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
