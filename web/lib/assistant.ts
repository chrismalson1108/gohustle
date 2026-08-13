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
// Pass confirmActionId to EXECUTE a staged action. The gate stages anything
// hard to undo (posting a gig, booking work) instead of doing it, and hands back a
// confirm_action; nothing happens until this second round trip carries the id. The
// model is not involved in that trip — it never sees the id and cannot mint one.
export async function askAssistant(
  messages: AssistantMsg[],
  opts: { threadId?: string | null; newThread?: boolean; confirmActionId?: string } = {},
): Promise<AssistantReply> {
  return callEdgeFunction<AssistantReply>("assistant", {
    messages,
    ...(opts.threadId ? { thread_id: opts.threadId } : {}),
    ...(opts.newThread ? { new_thread: true } : {}),
    ...(opts.confirmActionId ? { confirm_action_id: opts.confirmActionId } : {}),
  });
}
