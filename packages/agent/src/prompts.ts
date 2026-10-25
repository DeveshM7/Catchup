import type { CallTree, Component, FunctionFact } from "@catchup/analyzer";
import type { FlowPlan } from "./carry.js";
import type { Area } from "./schemas.js";

export const LEGEND =
  "★ = important (calls an external system or crosses a component boundary). [id] = function ID. {x} = component. Calls are listed in the order they run. " +
  "Flags: [if] conditional, [on error] inside a catch block, [parallel] runs concurrently, [one of] one of several alternatives, " +
  "[passed as callback] handed to another function that calls it, [AI tool] a tool the AI model may decide to call, [writes] writes data, [shown above] already expanded earlier, " +
  "[renders] a UI component it renders, [on submit] a UI event handler, [request → X] the browser calls our server entry point X, [message \"t\"] the server streams a message of type t that this client function handles.";

const STEP_RULES = [
  "Group this flow into 4–8 steps that a developer would draw on a whiteboard (fewer only if the flow is tiny).",
  "Each step has:",
  '- label: at most 6 words, starting with a verb, e.g. "Check the API key".',
  "- summary: 1–2 plain sentences on what happens and why. Name external systems (Postgres, Redis, …) when the step uses them. No code, no function names.",
  "- functions: the function IDs that do this step's work, copied exactly from inside [ ] above. List every function that belongs to the step.",
  "- kind: main = the normal path; error = runs only when something fails or input is invalid; branch = an alternative path taken only sometimes.",
  "Every ★ function must be in at least one step. Order the steps as they run.",
];

export function flowPrompt(tree: CallTree, renderedTree: string, snippets: string, plan: FlowPlan): string {
  const parts = [
    `You are explaining one runtime flow of a codebase so a developer understands it without reading the code.`,
    "",
    `Flow: ${tree.entryPoint.label} (handler [${tree.entryPoint.handler}])`,
    `External systems touched: ${tree.systems.join(", ") || "none"}`,
    tree.partial ? `Some calls are only known at runtime (marked "?").` : "",
    "",
    `Call tree, computed from the code. ${LEGEND}`,
    renderedTree,
    "",
    "Source of the key functions:",
    snippets || "(none)",
    "",
    ...STEP_RULES,
  ];
  if (plan.mode === "update") {
    parts.push(
      "",
      "This flow was explained before; the code changed since. Change as little as possible.",
      "Previous steps:",
      JSON.stringify(plan.previous.steps.map(({ id, label, summary, functions, kind }) => ({ id, label, summary, functions, kind })), null, 1),
      `Unchanged steps (return each with its id; their text is kept as is): ${[...plan.keepIds].join(", ") || "none"}`,
      `Changed functions: ${plan.changed.join(", ") || "none"}`,
      `New functions: ${plan.added.join(", ") || "none"}`,
      `Removed functions: ${plan.removed.join(", ") || "none"}`,
      "Set id to the previous step's id when a step still describes the same thing; null for a new step.",
    );
  } else {
    parts.push("Set id to null for every step.");
  }
  return parts.filter((p, i, all) => p !== "" || all[i - 1] !== "").join("\n");
}

export type ComponentBrief = { component: Component; functions: FunctionFact[]; systems: string[] };

export function labelsPrompt(briefs: ComponentBrief[]): string {
  const blocks = briefs.map(({ component, functions, systems }) =>
    [
      `- id: ${component.id} (${component.kind}, ${component.files.length} files)`,
      `  files: ${component.files.slice(0, 10).join(", ")}${component.files.length > 10 ? ", …" : ""}`,
      `  functions: ${functions.slice(0, 12).map((f) => f.name).join(", ") || "none"}`,
      `  packages: ${component.packages.slice(0, 10).join(", ") || "none"}${systems.length ? `; external systems: ${systems.join(", ")}` : ""}`,
    ].join("\n"),
  );
  return [
    "Name each component (a group of files) of a codebase for an architecture diagram.",
    "For each id below return: name (2–4 words, Title Case, what it does, not the folder name repeated) and description (one sentence, at most 20 words).",
    "Return exactly one label per id, using the ids as written.",
    "",
    ...blocks,
  ].join("\n");
}

export type FlowSummary = { id: string; label: string; steps: string[]; systems: string[]; components: string[] };

export function areasPrompt(flows: FlowSummary[], previous: Area[]): string {
  const lines = flows.map(
    (f) => `- ${f.id}: ${f.label} | steps: ${f.steps.join(" → ")} | systems: ${f.systems.join(", ") || "none"} | components: ${f.components.join(", ")}`,
  );
  return [
    "Group these runtime flows of a codebase into 3–7 areas by product capability (e.g. \"Event tracking\", \"Auth\", \"Reports\"), most important first.",
    "Each area: id (kebab-case), name (1–3 words), description (one sentence), flows (flow ids exactly as written). Every flow goes in exactly one area.",
    previous.length
      ? `Previous areas (keep their ids and names where they still fit): ${previous.map((a) => `${a.id} "${a.name}"`).join(", ")}`
      : "",
    "",
    ...lines,
  ]
    .filter((l, i) => l !== "" || i > 2)
    .join("\n");
}
