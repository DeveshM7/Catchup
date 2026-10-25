# Target output: vercel/ai-chatbot @ c2f8235

_Hand-written, 2026-10-24. This is what Catchup should show a developer opening this repo for the first time ("since never"). Every claim cites code. It is the target for the explain rework and the reference answer for the onboarding eval._

_Two layers. **Layer 1** is the whole first screen: readable in under a minute, no file paths. **Layer 2** is only shown when you click into something._

---

# Layer 1: first screen

**What it is.** A chat app where an AI model can write documents, code and spreadsheets into a panel beside the chat.

**The parts.**

```
 Chat UI ──▶ Chat API ──▶ AI model
                │  ▲          │ calls tools
                │  └─ Artifacts (documents the model writes)
                ▼
     Postgres (chats, messages, documents)
```

**How it works, in one flow.**
1. You send a message → the server loads the chat and calls the AI model.
2. The model replies, or uses a tool to write a document.
3. Both stream back live; the document appears in the side panel.
4. Everything is saved.

**Start here:** `app/(chat)/api/chat/route.ts`

---

# Layer 2: on click

## 1. What this is (brief)

A Next.js chat app built on the Vercel AI SDK. You chat with a model picked from a short list (`lib/ai/models.ts`, routed through Vercel AI Gateway). The model can call **tools**. The main ones create or edit **artifacts**: a text document, code or a spreadsheet that streams into a side panel next to the chat and is saved with versions. Chats, messages, documents and users live in Postgres (Drizzle). Uploads go to Vercel Blob. Redis is optional, used for IP rate limits and resumable streams.

## 2. Key ideas (glossary)

| Idea | What it means here | Where |
| --- | --- | --- |
| **Artifact** | A document the model writes into the side panel. Kinds: `text`, `code`, `sheet` (plus `image` on the client only). Each kind has a server half (how the model writes it) and a client half (how it renders and handles stream parts). | `artifacts/<kind>/server.ts`, `artifacts/<kind>/client.tsx`, registries in `lib/artifacts/server.ts#documentHandlersByArtifactKind` and `components/chat/artifact.tsx#artifactDefinitions` |
| **Tool** | A function the chat model may call: `createDocument`, `updateDocument`, `editDocument`, `requestSuggestions`, `getWeather`. Up to 5 model steps per reply. | `lib/ai/tools/*`, wired in `app/(chat)/api/chat/route.ts#POST` |
| **Data stream** | One response stream that carries both the chat text and custom `data-*` parts (`data-kind`, `data-id`, `data-textDelta`, `data-finish`, `data-chat-title`…). Tools write artifact content into it; the client routes those parts to the artifact panel. | server: `createUIMessageStream` in `route.ts#POST`; client: `components/chat/data-stream-handler.tsx#DataStreamHandler` |
| **Guest vs regular user** | Visitors with no session are signed in as a guest automatically. Both types have the same limit (10 messages/hour). | `proxy.ts#proxy`, `app/(auth)/auth.ts` (two Credentials providers), `lib/ai/entitlements.ts` |
| **Model list** | A fixed allowlist of Gateway model IDs with capabilities (reasoning, tools). Reasoning models without tool support get no tools. | `lib/ai/models.ts#chatModels`, `#getCapabilities`, `lib/ai/providers.ts#getLanguageModel` |

## 3. The flow that matters: sending a message

_Client and server, at the level of ideas. Checks are one line, not steps._

1. **The UI posts the conversation.** `useChat` in `hooks/use-active-chat.tsx` sends the new message, chat id and selected model to `POST /api/chat`.
   _Checks:_ body is valid, not a bot (BotID), signed in, IP and per-user rate limits, owns the chat.
2. **Load or start the chat.** An existing chat loads its history from Postgres. A new chat is saved as "New chat", and a title is generated in parallel by a second model call (`app/(chat)/actions.ts#generateTitleFromUserMessage`). The user message is saved before the model runs.
3. **Run the model with tools.** `streamText` gets the system prompt (`lib/ai/prompts.ts#systemPrompt`, including the user's city from geolocation), the history and the tools. The reply streams back as it is generated. A timer shows "may be slow" if nothing arrives within 9 s.
4. **If the model calls `createDocument`, an artifact is written.** The tool sends `data-kind/id/title` to the client, then hands off to the kind's handler (`artifacts/text/server.ts`, etc.). That handler makes a **second `streamText` call** to write the content, streaming each delta as `data-textDelta`, and finally saves the document to Postgres. `updateDocument`/`editDocument` work the same way on an existing document.
5. **The client fills the side panel.** `DataStreamHandler` reads the `data-*` parts, opens the artifact panel and appends content as it arrives. The kind's `client.tsx` decides how it renders.
6. **Save the reply.** When the stream ends, the assistant messages (including tool calls) are saved; the title is written once it is ready and the sidebar refreshes.

_Variant:_ **tool approval**. If the request carries `messages` instead of `message`, the user is answering a tool-approval prompt. The server merges the approval states into the stored messages and updates them instead of appending.

## 4. Other flows, one line each

| Flow | One line |
| --- | --- |
| Open a chat | The page file renders nothing; `hooks/use-active-chat.tsx` fetches `GET /api/messages?chatId=…`, which hides private chats from anyone but the owner. |
| Edit an artifact by hand | `POST /api/document` saves a new version (same id, new `createdAt`); `GET` returns all versions; `DELETE` removes versions after a timestamp. |
| Suggestions | The `requestSuggestions` tool asks the model for edits to a document and saves them; `GET /api/suggestions` serves them to the editor. |
| Vote | `PATCH /api/vote` up/down-votes an assistant message. |
| History sidebar | `GET /api/history` pages through your chats; `DELETE` removes all of them. |
| Upload a file | `POST /api/files/upload` accepts JPEG/PNG up to 5 MB and stores it in Vercel Blob; the URL is attached to the next message. |
| Sign in / guest | `proxy.ts` redirects anyone without a token to `/api/auth/guest`, which creates a guest user. `/login` and `/register` upgrade to a regular account. |

## 5. Start here

1. `app/(chat)/api/chat/route.ts`: the whole server side of a chat turn.
2. `lib/ai/tools/create-document.ts` → `lib/artifacts/server.ts` → `artifacts/text/server.ts`: how a tool becomes a streamed, saved artifact.
3. `components/chat/data-stream-handler.tsx` + `components/chat/artifact.tsx`: how the client shows it.
4. `lib/db/schema.ts`: 7 tables (User, Chat, Message_v2, Vote, Document, Suggestion, Stream).

## 6. Common changes: where to go

| I want to… | Touch |
| --- | --- |
| Add or swap a model | `lib/ai/models.ts#chatModels` (and `providers.ts` if not on Gateway) |
| Add a tool | new file in `lib/ai/tools/`, register it in `tools` **and** `activeTools` in `route.ts#POST` |
| Add an artifact kind | `artifacts/<kind>/server.ts` + `client.tsx`, add to both registries and `artifactKinds` |
| Change the assistant's behavior | `lib/ai/prompts.ts` |
| Change rate limits | `lib/ai/entitlements.ts`, `lib/ratelimit.ts` |

## 7. Surprises worth flagging

- **Resume is half-wired.** `POST /api/chat` stores a resumable stream in Redis when `REDIS_URL` is set, and `hooks/use-auto-resume.ts` calls `resumeStream()`, but `GET /api/chat/[id]/stream` just returns 204. A dropped stream will not actually resume.
- **Guest and regular limits are identical** (10/hour), so the user type currently changes nothing in `entitlements.ts`.
- **Tool approval has no customer.** The server and the UI (`components/chat/message.tsx#ToolApprovalActions`) handle approvals, but no tool in `lib/ai/tools/` asks for one.
- **`image` artifacts exist only on the client**: there is no server handler, so `createDocument` cannot produce one.

---

## What this target asks of the pipeline (vs. what we show today)

| Target needs | Today | Gap |
| --- | --- | --- |
| Brief + key ideas | nothing | new repo-level explain step, cited |
| Components named by role ("Artifacts", "AI tools", "Chat API", "Auth") | folder names: `lib: Core Library`, `components: UI Components` | grouping by role, not top-level folder (D19 is too coarse for a repo this size) |
| Chat flow spans client → server → tool → second model call → client | server only; tools collapsed into "Prepare model, prompt, and tools", artifact writing invisible | follow tool `execute` bodies as steps; link `data-*` writes to client handlers |
| Checks folded into one line | 1–3 separate "Reject…" steps per route | treat `error` steps as a checks line in the schema/UI |
| One flow in depth, others in one line | all 15 routes at the same 4–8-step depth | rank by centrality; explain top 1–3 deeply |
| "Start here" / "where to change X" | nothing | derive from flow centrality + registries |
| Surprises (dead ends, half-wired features) | nothing | deterministic checks (route that does nothing, registry mismatch) + Claude wording |
