// Team management for admins: add a person, edit them, reset PIN, deactivate.
import { admin, caller, cors, json } from "../_shared/common.ts";

const USERNAME = /^[a-z0-9._-]{3,30}$/;
const ROLES = ["admin", "manager", "staff"];

function normPhone(p: unknown) {
  const d = String(p ?? "").replace(/[^\d+]/g, "");
  if (!d) return null;
  if (d.startsWith("+")) return d;
  if (d.length === 10) return "+91" + d;
  if (d.length === 12 && d.startsWith("91")) return "+" + d;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const me = await caller(req);
  if (!me) return json({ error: "Please log in again." }, 401);
  if (me.role !== "admin") return json({ error: "Only an admin can manage the team." }, 403);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  if (b.action === "create") {
    const name = String(b.name || "").trim();
    const username = String(b.username || "").trim().toLowerCase();
    const secret = String(b.pin || "");
    const role = ROLES.includes(String(b.role)) ? String(b.role) : "staff";
    const realEmail = String(b.email || "").trim().toLowerCase();
    const phone = b.phone ? normPhone(b.phone) : null;
    if (!name) return json({ error: "Enter a name." }, 400);
    if (!USERNAME.test(username)) return json({ error: "Username: 3–30 letters, numbers, dot, dash or underscore. No spaces." }, 400);
    if (secret.length < 6) return json({ error: "PIN must be at least 6 digits." }, 400);
    if (b.phone && !phone) return json({ error: "Enter the mobile number as 10 digits, or with +country code." }, 400);
    const { data: clash } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
    if (clash) return json({ error: `Username "${username}" is already taken.` }, 409);

    const reportsTo = typeof b.reports_to === "string" && b.reports_to ? b.reports_to : null;
    if (reportsTo) {
      const { data: boss } = await admin.from("profiles").select("id").eq("id", reportsTo).maybeSingle();
      if (!boss) return json({ error: "The chosen boss was not found." }, 400);
    }

    const { data, error } = await admin.auth.admin.createUser({
      email: realEmail || `${username}@staff.floortask.app`,
      password: secret,
      phone: phone ?? undefined,
      email_confirm: true,
      phone_confirm: !!phone,
      user_metadata: { name, username, dept: b.dept || null, role, reports_to: reportsTo },
    });
    if (error) {
      if (phone && /phone/i.test(error.message)) {
        return json({ error: "Mobile login isn't set up yet. Leave the mobile number empty for now." }, 400);
      }
      return json({ error: error.message }, 400);
    }
    return json({ ok: true, id: data.user?.id });
  }

  if (b.action === "update") {
    const id = String(b.id || "");
    const { data: target } = await admin.from("profiles").select("*").eq("id", id).maybeSingle();
    if (!target) return json({ error: "Person not found." }, 404);

    const profile: Record<string, unknown> = {};
    if (typeof b.name === "string" && b.name.trim()) profile.name = b.name.trim();
    if (typeof b.dept === "string") profile.dept = b.dept || null;
    if (typeof b.role === "string" && ROLES.includes(b.role)) {
      if (id === me.id && b.role !== "admin") return json({ error: "You cannot remove your own admin role." }, 400);
      profile.role = b.role;
    }
    if (typeof b.username === "string" && b.username.trim()) {
      const u = b.username.trim().toLowerCase();
      if (!USERNAME.test(u)) return json({ error: "Username: 3–30 letters, numbers, dot, dash or underscore." }, 400);
      if (u !== target.username) {
        const { data: clash } = await admin.from("profiles").select("id").eq("username", u).maybeSingle();
        if (clash) return json({ error: `Username "${u}" is already taken.` }, 409);
      }
      profile.username = u;
    }
    if (typeof b.active === "boolean") {
      if (id === me.id && !b.active) return json({ error: "You cannot deactivate yourself." }, 400);
      profile.active = b.active;
    }
    if (b.reports_to !== undefined) {
      const boss = typeof b.reports_to === "string" && b.reports_to ? b.reports_to : null;
      if (boss === id) return json({ error: "A person cannot report to themselves." }, 400);
      profile.reports_to = boss;
    }

    const auth: Record<string, unknown> = {};
    if (typeof b.pin === "string" && b.pin) {
      if (b.pin.length < 6) return json({ error: "PIN must be at least 6 digits." }, 400);
      auth.password = b.pin;
    }
    if (typeof b.email === "string" && b.email.trim()) { auth.email = b.email.trim().toLowerCase(); auth.email_confirm = true; }
    if (b.phone !== undefined) {
      const p = b.phone ? normPhone(b.phone) : null;
      if (b.phone && !p) return json({ error: "Enter the mobile number as 10 digits, or with +country code." }, 400);
      auth.phone = p ?? "";
      if (p) auth.phone_confirm = true;
      profile.phone = p;
    }
    if (typeof b.active === "boolean") auth.ban_duration = b.active ? "none" : "876000h";

    if (Object.keys(auth).length) {
      const { error } = await admin.auth.admin.updateUserById(id, auth);
      if (error) return json({ error: error.message }, 400);
    }
    if (Object.keys(profile).length) {
      const { error } = await admin.from("profiles").update(profile).eq("id", id);
      if (error) return json({ error: error.message.replace(/^.*?:\s*(?=That would|A person)/, "") }, 400);
    }
    if (b.active === false) await admin.from("push_subscriptions").delete().eq("user_id", id);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
});
