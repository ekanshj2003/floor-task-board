// Instant notifications:
//   • people added to a task, each told their role (Responsible / Accountable / Consulted / Informed)
//   • follow-up added, task marked done
// Called by database triggers (with x-cron-secret), or by a signed-in user for a test push.
import { admin, caller, cors, fmtWhen, fromDatabase, json, names, notifyUser, Task, uniq } from "../_shared/common.ts";

type Person = { id: string; role: "R" | "A" | "C" | "I" };
const RANK = { R: 0, A: 1, C: 2, I: 3 };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }

  // Test notification from the app
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
    if (!t || t.status === "done") return json({ skipped: true });

    let people = Array.isArray(body.people) ? (body.people as Person[]) : [
      { id: t.assignee!, role: "R" as const },
      { id: t.accountable!, role: "A" as const },
      ...(t.consulted || []).map((id) => ({ id, role: "C" as const })),
      ...(t.informed || []).map((id) => ({ id, role: "I" as const })),
    ];
    // One alert per person, using their most important role on this task
    const best = new Map<string, Person>();
    for (const p of people) {
      if (!p?.id) continue;
      const cur = best.get(p.id);
      if (!cur || RANK[p.role] < RANK[cur.role]) best.set(p.id, p);
    }
    const actor = typeof body.actor === "string" ? body.actor : t.assigned_by;
    people = [...best.values()].filter((p) => p.id !== actor);
    if (!people.length) return json({ skipped: "nobody" });

    const n = await names([t.assigned_by, t.assignee, t.accountable, actor]);
    const from = actor ? n[actor] ?? "Manager" : "Manager";
    const R = t.assignee ? n[t.assignee] ?? "—" : "—";
    const A = t.accountable ? n[t.accountable] ?? "—" : "—";
    const when = fmtWhen(t.due);
    const hi = t.priority === "high" ? "🔴 " : "";

    await Promise.all(people.map((p) => {
      const msg = {
        R: { title: `${hi}New task: ${t.title}`, body: `Deadline: ${when} · from ${from} · You are Responsible` },
        A: { title: `${hi}You're accountable: ${t.title}`, body: `Responsible: ${R} · Deadline: ${when}` },
        C: { title: `Your input needed: ${t.title}`, body: `You are Consulted · Responsible: ${R} · Deadline: ${when}` },
        I: { title: `FYI: ${t.title}`, body: `You are kept Informed · Responsible: ${R} · Accountable: ${A} · Deadline: ${when}` },
      }[p.role];
      return notifyUser(p.id, { kind: "assigned", taskId: t.id, ...msg });
    }));
    return json({ ok: true, notified: people.length });
  }

  if (body.type === "followup" && (typeof body.followup_id === "number" || typeof body.followup_id === "string")) {
    const { data: f } = await admin.from("followups").select("*").eq("id", body.followup_id).maybeSingle();
    if (!f) return json({ skipped: true });
    const { data: t } = await admin.from("tasks").select("*").eq("id", f.task_id).maybeSingle<Task>();
    if (!t) return json({ skipped: true });
    const n = await names([f.author]);
    const who = f.author ? n[f.author] ?? "Someone" : "Someone";
    const done = /^Marked as done/i.test(f.note);
    // Updates go to R, A, C and whoever assigned it; "done" also goes to Informed
    const recipients = uniq([
      t.assignee, t.accountable, t.assigned_by, ...(t.consulted || []), ...(done ? t.informed || [] : []),
    ]).filter((id) => id !== f.author);
    await Promise.all(recipients.map((uid) =>
      notifyUser(uid, {
        kind: done ? "done" : "followup",
        taskId: t.id,
        title: done ? `✅ Done: ${t.title}` : `Update: ${t.title}`,
        body: `${who}: ${f.note}`.slice(0, 240),
      })
    ));
    return json({ ok: true, recipients: recipients.length });
  }

  return json({ error: "unknown type" }, 400);
});
