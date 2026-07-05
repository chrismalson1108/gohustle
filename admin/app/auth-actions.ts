"use server";

import { redirect } from "next/navigation";
import { getServerSupabase } from "@/lib/supabaseServer";

export async function signOutAction(): Promise<void> {
  const supa = await getServerSupabase();
  await supa.auth.signOut();
  redirect("/login");
}
