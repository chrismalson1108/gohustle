// .edu student verification — thin wrappers over the edge functions (web).
import { callEdgeFunction } from "./edge";

export function startStudentVerification(email: string) {
  return callEdgeFunction<{ ok: boolean }>("student-verify-start", { email });
}

export function confirmStudentVerification(email: string, code: string) {
  return callEdgeFunction<{ verified: boolean; school: string | null; schoolDomain: string }>(
    "student-verify-confirm",
    { email, code },
  );
}
