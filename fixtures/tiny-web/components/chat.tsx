"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import useSWR from "swr";
import { rename } from "../app/actions";
import { fetcher } from "../lib/fetcher";
import { Composer } from "./composer";
import { handlePart } from "./parts";

export function Chat() {
  const { sendMessage, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    onData: (part) => handlePart(part),
  });
  const { data } = useSWR("/api/history", fetcher);
  return (
    <div>
      {data ? <Composer send={sendMessage} stop={stop} /> : null}
      <button onClick={() => fetch("/api/history?all=1", { method: "DELETE" })}>clear</button>
      <button onClick={() => rename("Renamed")}>rename</button>
    </div>
  );
}
