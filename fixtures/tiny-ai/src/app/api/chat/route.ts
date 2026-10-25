import { streamText } from "ai";
import { draft } from "@/tools/draft";
import { weather } from "@/tools/weather";

export async function POST(request: Request) {
  const { prompt } = await request.json();
  const result = streamText({
    prompt,
    tools: { draft: draft({ user: "u" }), weather },
  });
  return result.toResponse();
}
