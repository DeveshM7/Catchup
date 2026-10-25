import type { UseChatHelpers } from "@ai-sdk/react";

export function Composer({ send, stop }: { send: UseChatHelpers["sendMessage"]; stop: () => void }) {
  const submit = () => {
    send({ text: "hi" });
  };
  return (
    <form onSubmit={submit}>
      <button onClick={stop}>stop</button>
    </form>
  );
}
