// Instant notifications: new task assigned, task reassigned, follow-up added.
// Called by database triggers (with x-cron-secret), or by a signed-in user for a test push.
import { admin, caller, cors, fmtWhen, fromDatabase, json, names, notifyUser, Task } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }

  // Test notification from the app's settings screen
  if (body.type === "test") {
    const me = await caller(req);
    if (!me) return json({ error: "Please log in again." }, 401);
    const sent = await notifyUser(me.id, {
      kind: "test",
      title: "Notifications are working",
      body: `Hi ${me.name}, you will get new tasks and deadline alerts on this phone.`,
    });
    return json({ sent });
  }

  if (!fromDatabase(req)) return json({ error: "forbidden" }, 403);

  if (body.type === "assigned" && typeof body.task_id === "string") {
    const { data: t } = await admin.from("tasks").select("*").eq("id", body.task_id).maybeSingle<Task>();
    if (!t || !t.assignee || t.status === "done") return json({ skipped: true });
    if (t.assignee === t.assigned_by) return json({ skipped: "self" });
    const n = await names([t.assigned_by]);
    const from = t.assigned_by ? n[t.assigned_by] : "Manager";
    await notifyUser(t.assignee, {
      kind: "assigned",
      taskId: t.id,
      title: `${t.priority === "high" ? "🔴 " : ""}New task: ${t.title}`,
      body: `Deadline: ${fmtWhen(t.due)} · from ${from}${t.dept ? ` · ${t.dept}` : ""}`,
    });
    return json({ ok: true });
  }

  if (body.type === "followup" && (typeof body.followup_id === "number" || typeof body.followup_id === "string")) {
    const { data: f } = await admin.from("followups").select("*").eq("id", body.followup_id).maybeSingle();
    if (!f) return json({ skipped: true });
    const { data: t } = await admin.from("tasks").select("*").eq("id", f.task_id).maybeSingle<Task>();
    if (!t) return json({ skipped: true });
    const n = await names([f.author]);
    const who = f.author ? n[f.author] ?? "Someone" : "Someone";
    const recipients = new Set([t.assignee, t.assigned_by].filter((x) => x && x !== f.author) as string[]);
    const done = /^Marked as done/i.test(f.note);
    await Promise.all([...recipients].map((uid) =>
      notifyUser(uid, {
        kind: done ? "done" : "followup",
        taskId: t.id,
        title: done ? `✅ Done: ${t.title}` : `Update: ${t.title}`,
        body: `${who}: ${f.note}`.slice(0, 240),
      })
    ));
    return json({ ok: true, recipients: recipients.size });
  }

  return json({ error: "unknown type" }, 400);
});
