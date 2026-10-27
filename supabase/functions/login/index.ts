// Username + PIN login. Looks up the account by username, checks the PIN,
// and returns a normal session. Locks a username for 15 minutes after 5 wrong PINs.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { admin, ANON_KEY, cors, json, SUPABASE_URL } from "../_shared/common.ts";

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let username = "", pin = "";
  try {
    const b = await req.json();
    username = String(b.username || "").trim().toLowerCase();
    pin = String(b.pin || "");
  } catch { /* fallthrough */ }
  const wrong = json({ error: "Wrong username or PIN." }, 401);
  if (!username || !pin) return wrong;

  const { data: attempt } = await admin.from("login_attempts").select("*").eq("username", username).maybeSingle();
  if (attempt?.locked_until && Date.parse(attempt.locked_until) > Date.now()) {
    const mins = Math.ceil((Date.parse(attempt.locked_until) - Date.now()) / 60000);
    return json({ error: `Too many wrong PINs. Try again in ${mins} min, or ask your admin to reset your PIN.` }, 429);
  }

  const { data: profile } = await admin.from("profiles").select("id,active").eq("username", username).maybeSingle();
  let email: string | undefined;
  if (profile?.active) {
    const { data } = await admin.auth.admin.getUserById(profile.id);
    email = data.user?.email ?? undefined;
  }

  if (email) {
    const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const { data, error } = await anon.auth.signInWithPassword({ email, password: pin });
    if (!error && data.session) {
      await admin.from("login_attempts").delete().eq("username", username);
      return json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
    }
  }

  const failed = (attempt?.failed ?? 0) + 1;
  await admin.from("login_attempts").upsert({
    username,
    failed: failed >= MAX_FAILS ? 0 : failed,
    locked_until: failed >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null,
  });
  return wrong;
});
