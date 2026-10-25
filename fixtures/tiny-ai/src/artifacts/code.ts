import { streamText } from "ai";
import { createHandler } from "./factory";

export const codeHandler = createHandler({
  kind: "code",
  onCreate: async ({ title }) => stripFences(streamText({ prompt: title }).text),
});

function stripFences(text: string): string {
  return text.replace(/```/g, "");
}
