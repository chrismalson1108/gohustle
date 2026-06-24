"use client";

import { AuthProvider } from "@/lib/auth";

// Root-level providers. AuthProvider is global (login/onboarding/marketing all
// read session state). UserProvider + JobsProvider are mounted deeper, inside the
// authenticated (app) layout where a signed-in user is guaranteed.
export default function Providers({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
