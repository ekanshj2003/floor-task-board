// Shared helpers for the Floor Task Board edge functions.
import webpush from "npm:web-push@3.6.7";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export const admin: SupabaseClient = createClient(
  SUPABASE_URL,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY");
let pushReady = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    let subject = (Deno.env.get("VAPID_SUBJECT") || "").trim();
    if (subject && !/^(mailto:|https:)/i.test(subject)) subject = "mailto:" + subject;
    webpush.setVapidDetails(subject || "mailto:admin@example.com", VAPID_PUBLIC.trim(), VAPID_PRIVATE.trim());
    pushReady = true;
  } catch (e) {
    // A bad key must not stop the other functions (login, team) from working
    console.error("VAPID keys are invalid; push disabled:", (e as Error).message);
  }
}

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/** True when the request comes from our own database (pg_net / pg_cron). */
export function fromDatabase(req: Request) {
  const s = Deno.env.get("CRON_SECRET");
  return !!s && req.headers.get("x-cron-secret") === s;
}

/** The signed-in user calling the function, with their profile, or null. */
export async function caller(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token === ANON_KEY) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: profile } = await admin.from("profiles").select("*").eq("id", data.user.id).maybeSingle();
  if (!profile || !profile.active) return null;
  return profile as Profile;
}

export type Profile = {
  id: string; name: string; username: string | null; dept: string | null; role: string; active: boolean;
  reports_to: string | null;
};
export type Task = {
  id: string; title: string; details: string; dept: string | null;
  assignee: string | null; // Responsible
  accountable: string | null; // Accountable
  consulted: string[] | null; // Consulted
  informed: string[] | null; // Informed
  assigned_by: string | null;
  due: string; priority: string; status: string; created_at: string;
  sent_24h: boolean; sent_morning: boolean; sent_1h: boolean; sent_overdue: boolean; escalation_level: number;
};

export const ROLE_NAME: Record<string, string> = { R: "Responsible", A: "Accountable", C: "Consulted", I: "Informed" };

/** Unique, non-empty list of user ids */
export function uniq(ids: (string | null | undefined)[]) {
  return [...new Set(ids.filter(Boolean) as string[])];
}

const IST = "Asia/Kolkata";
export function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: IST, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  });
}
export function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit" });
}
export function names(ids: (string | null | undefined)[]) {
  return admin.from("profiles").select("id,name").in("id", uniq(ids))
    .then(({ data }) => Object.fromEntries((data || []).map((p) => [p.id, p.name as string])));
}

/**
 * Saves an alert in the user's in-app inbox and pushes it to every phone
 * the user turned notifications on for.
 */
export async function notifyUser(
  userId: string | null,
  msg: { title: string; body: string; taskId?: string | null; kind: string },
) {
  if (!userId) return 0;
  const { data: p } = await admin.from("profiles").select("active").eq("id", userId).maybeSingle();
  if (!p?.active) return 0;

  await admin.from("notifications").insert({
    user_id: userId, task_id: msg.taskId ?? null, kind: msg.kind, title: msg.title, body: msg.body,
  });

  if (!pushReady) {
    console.error("VAPID keys are missing or invalid; alert saved in the app but not pushed");
    return 0;
  }
  const { data: subs } = await admin.from("push_subscriptions").select("*").eq("user_id", userId);
  const payload = JSON.stringify({
    title: msg.title,
    body: msg.body,
    url: msg.taskId ? `./#task/${msg.taskId}` : "./#alerts",
    tag: `${msg.kind}-${msg.taskId ?? Date.now()}`,
  });
  let sent = 0;
  await Promise.all((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 12, urgency: "high" },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        // The phone unsubscribed or the app was removed
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      } else {
        console.error("push failed", code, (e as Error).message);
      }
    }
  }));
  return sent;
}
