// Deadline reminders. Runs every 5 minutes (pg_cron → this function).
//   • 24 hours before the deadline
//   • 9 AM (India time) on the day of the deadline
//   • 1 hour before the deadline
//   • When the deadline passes (to the person AND the one who assigned it)
import { admin, cors, fmtTime, fmtWhen, fromDatabase, json, names, notifyUser, Task } from "../_shared/common.ts";

const HOUR = 3600_000;
const IST_OFFSET = 5.5 * HOUR;
const MORNING_HOUR = 9;

const istDay = (ms: number) => new Date(ms + IST_OFFSET).toISOString().slice(0, 10);
const istHour = (ms: number) => new Date(ms + IST_OFFSET).getUTCHours();
/** Today 09:00 India time, as epoch ms */
const istMorning = (ms: number) => Date.parse(`${istDay(ms)}T${String(MORNING_HOUR).padStart(2, "0")}:00:00+05:30`);

function late(ms: number) {
  const h = Math.floor(ms / HOUR), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${Math.floor((ms % HOUR) / 60000)}m` : `${Math.max(1, Math.floor(ms / 60000))}m`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!fromDatabase(req)) return json({ error: "forbidden" }, 403);

  const now = Date.now();
  const { data, error } = await admin.from("tasks").select("*")
    .neq("status", "done")
    .not("assignee", "is", null)
    .lte("due", new Date(now + 24 * HOUR).toISOString())
    .eq("sent_overdue", false)
    .limit(500);
  if (error) return json({ error: error.message }, 500);
  const tasks = (data || []) as Task[];
  if (!tasks.length) return json({ checked: 0 });

  const n = await names(tasks.flatMap((t) => [t.assignee, t.assigned_by]));
  let sent = 0;

  for (const t of tasks) {
    const due = Date.parse(t.due), created = Date.parse(t.created_at), left = due - now;
    const flags: Partial<Task> = {};
    const tag = t.priority === "high" ? " (High priority)" : "";

    if (left <= 0) {
      await notifyUser(t.assignee, {
        kind: "overdue", taskId: t.id,
        title: `⏰ Overdue: ${t.title}`,
        body: `Deadline was ${fmtWhen(t.due)} (${late(-left)} ago). Update the status or add a follow-up.`,
      });
      if (t.assigned_by && t.assigned_by !== t.assignee) {
        await notifyUser(t.assigned_by, {
          kind: "overdue", taskId: t.id,
          title: `⏰ Overdue: ${t.title}`,
          body: `${n[t.assignee!] ?? "Assignee"} has not finished it. Deadline was ${fmtWhen(t.due)}.`,
        });
      }
      Object.assign(flags, { sent_overdue: true, sent_1h: true, sent_morning: true, sent_24h: true });
    } else if (left <= HOUR) {
      if (!t.sent_1h && created < due - HOUR) {
        await notifyUser(t.assignee, {
          kind: "due_1h", taskId: t.id,
          title: `Due in 1 hour: ${t.title}`,
          body: `Deadline ${fmtTime(t.due)} today.${tag}`,
        });
        sent++;
      }
      Object.assign(flags, { sent_1h: true, sent_morning: true, sent_24h: true });
    } else {
      const morning = istMorning(now);
      if (!t.sent_morning && istDay(due) === istDay(now) && istHour(now) >= MORNING_HOUR) {
        if (created < morning) {
          await notifyUser(t.assignee, {
            kind: "due_today", taskId: t.id,
            title: `Due today: ${t.title}`,
            body: `Deadline ${fmtTime(t.due)} today.${tag}`,
          });
          sent++;
        }
        Object.assign(flags, { sent_morning: true, sent_24h: true });
      } else if (!t.sent_24h && left <= 24 * HOUR) {
        if (created < due - 24 * HOUR) {
          await notifyUser(t.assignee, {
            kind: "due_24h", taskId: t.id,
            title: `Due in 24 hours: ${t.title}`,
            body: `Deadline ${fmtWhen(t.due)}.${tag}`,
          });
          sent++;
        }
        flags.sent_24h = true;
      }
    }

    if (Object.keys(flags).length) {
      // Only update if the deadline was not changed meanwhile
      await admin.from("tasks").update(flags).eq("id", t.id).eq("due", t.due);
    }
  }
  return json({ checked: tasks.length, sent });
});
