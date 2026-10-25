import { streamText } from "ai";
import { createHandler } from "./factory";

export const textHandler = createHandler({
  kind: "text",
  onCreate: async ({ title }) => {
    const { text } = streamText({ prompt: title });
    return text;
  },
});
