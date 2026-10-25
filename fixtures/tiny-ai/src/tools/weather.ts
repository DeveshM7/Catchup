import { tool } from "ai";

export const weather = tool({
  execute: async ({ city }: { city: string }) => forecast(city),
});

function forecast(city: string) {
  return { city, temp: 20 };
}
