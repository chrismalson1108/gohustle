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
}

// Calls the `assistant` edge function (Claude tool-use loop) with the running
// transcript and returns the assistant's reply plus any actions it performed
// (so the UI can refresh the affected slices of state).
export async function askAssistant(messages: AssistantMsg[]): Promise<AssistantReply> {
  return callEdgeFunction<AssistantReply>("assistant", { messages });
}
