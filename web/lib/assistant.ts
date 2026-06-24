import { callEdgeFunction } from "./edge";

export interface AssistantMsg {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantAction {
  type: string;
  [k: string]: unknown;
}

export interface AssistantReply {
  reply: string;
  actions: AssistantAction[];
  thread_id?: string | null;
}

// Calls the `assistant` edge function (Claude tool-use loop) with the running
// transcript and returns the assistant's reply plus any actions it performed
// (so the UI can refresh the affected slices of state). Pass a threadId to
// continue (and persist to) a saved conversation, or newThread to start one.
export async function askAssistant(
  messages: AssistantMsg[],
  opts: { threadId?: string | null; newThread?: boolean } = {},
): Promise<AssistantReply> {
  return callEdgeFunction<AssistantReply>("assistant", {
    messages,
    ...(opts.threadId ? { thread_id: opts.threadId } : {}),
    ...(opts.newThread ? { new_thread: true } : {}),
  });
}
