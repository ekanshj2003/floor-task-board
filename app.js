/* Floor Task Board — phone app (vanilla JS + Supabase) */
"use strict";

const C = window.APP_CONFIG || {};
const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const S = {
  me: null, profiles: [], depts: [], tasks: [], alerts: [],
  f: { dept: "All", view: "pending", mine: false, q: "" },
  ch: null, notes: [], openTaskId: null,
};
try { Object.assign(S.f, JSON.parse(localStorage.getItem("filters") || "{}")); } catch { /* ignore */ }

/* ───────────── helpers ───────────── */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isMgr = () => S.me && (S.me.role === "admin" || S.me.role === "manager");
const isAdmin = () => S.me && S.me.role === "admin";
const person = (id) => S.profiles.find((p) => p.id === id);
const pname = (id) => person(id)?.name || "—";
const H = 36e5, D = 864e5;
const ms = (iso) => (iso ? Date.parse(iso) : 0);
const TZ = "Asia/Kolkata";
const fmt = (iso) => new Date(iso).toLocaleString("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmtLong = (iso) => new Date(iso).toLocaleString("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
function ago(iso) { const d = Date.now() - ms(iso); if (d < 6e4) return "just now"; if (d < H) return Math.floor(d / 6e4) + " min ago"; if (d < D) return Math.floor(d / H) + " hr ago"; return fmt(iso); }
function span(a) { const h = Math.floor(a / H), d = Math.floor(h / 24), m = Math.floor((a % H) / 6e4); return d >= 1 ? `${d}d ${h % 24}h` : h >= 1 ? `${h}h ${m}m` : `${Math.max(1, m)}m`; }
function timeLeft(t) {
  if (t.status === "done") return { cls: "done", txt: "Done " + (t.done_at ? fmt(t.done_at) : "") };
  const diff = ms(t.due) - Date.now();
  if (diff < 0) return { cls: "late", txt: span(-diff) + " late" };
  return { cls: diff < D ? "soon" : "fine", txt: span(diff) + " left" };
}
const STATUS = { open: "Not started", progress: "In progress", done: "Done" };
function toLocalInput(d) { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); }
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }
function saveFilters() { try { localStorage.setItem("filters", JSON.stringify({ dept: S.f.dept, view: S.f.view, mine: S.f.mine })); } catch { /* ignore */ } }
function friendly(err) {
  const m = (err && (err.message || err.error_description || err.error)) || String(err || "");
  if (/Failed to fetch|NetworkError/i.test(m)) return "No internet connection. Try again.";
  if (/manager can edit/i.test(m)) return "Only a manager can change task details.";
  if (/row-level security|permission/i.test(m)) return "You don't have permission to do that.";
  return m || "Something went wrong. Try again.";
}
async function fnCall(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return data;
}
const ICON = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5c2.5 0 4.5 1.5 5.5 4.5"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;

/* ───────────── data ───────────── */
async function loadAll() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { S.me = null; return; }
  const [p, d, t, n] = await Promise.all([
    sb.from("profiles").select("*").order("name"),
    sb.from("departments").select("*").order("sort").order("name"),
    sb.from("tasks").select("*").order("due"),
    sb.from("notifications").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
  ]);
  if (p.error) throw p.error;
  S.profiles = p.data || [];
  S.me = S.profiles.find((x) => x.id === user.id) || null;
  if (!S.me || !S.me.active) {
    await sb.auth.signOut();
    S.me = null;
    toast("This account is not active. Ask your admin.");
    return;
  }
  S.depts = (d.data || []).map((x) => x.name);
  S.tasks = t.data || [];
  S.alerts = n.data || [];
  subscribe();
  syncPush();
}
async function refreshTasks() { const { data } = await sb.from("tasks").select("*").order("due"); if (data) S.tasks = data; }
async function refreshAlerts() {
  const { data } = await sb.from("notifications").select("*").eq("user_id", S.me.id).order("created_at", { ascending: false }).limit(100);
  if (data) S.alerts = data;
}
let reTimer;
function soon(fn) { clearTimeout(reTimer); reTimer = setTimeout(fn, 250); }
function subscribe() {
  if (S.ch) return;
  S.ch = sb.channel("live")
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => soon(async () => { await refreshTasks(); rerender(); }))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "followups" }, (p) => {
      if (S.openTaskId && p.new.task_id === S.openTaskId) soon(() => viewTask(S.openTaskId, true));
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${S.me.id}` }, (p) => {
      S.alerts.unshift(p.new); toast(p.new.title); renderTabbar();
      if (route().name === "alerts") viewAlerts();
    })
    .subscribe();
}
function unsubscribe() { if (S.ch) { sb.removeChannel(S.ch); S.ch = null; } }

/* ───────────── push notifications ───────────── */
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function b64ToU8(b64) { const p = "=".repeat((4 - (b64.length % 4)) % 4); const s = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
async function swReady() {
  return Promise.race([navigator.serviceWorker.ready, new Promise((_, r) => setTimeout(() => r(new Error("Service worker not ready")), 6000))]);
}
async function pushState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIOS() && !standalone() ? "ios-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  try { const reg = await swReady(); return (await reg.pushManager.getSubscription()) ? "on" : "off"; } catch { return "off"; }
}
async function saveSub(sub) {
  const j = sub.toJSON();
  const { error } = await sb.from("push_subscriptions").upsert({
    endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_id: S.me.id, user_agent: navigator.userAgent.slice(0, 200),
  });
  if (error) throw error;
}
async function enablePush() {
  const st = await pushState();
  if (st === "ios-install") { toast("On iPhone: tap Share, then Add to Home Screen, and open the app from there."); return false; }
  if (st === "unsupported") { toast("This browser can't show notifications. Use Chrome on Android or Safari on iPhone."); return false; }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Notifications are blocked. Allow them in your phone settings for this app."); return false; }
  try {
    const reg = await swReady();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(C.VAPID_PUBLIC_KEY) });
    await saveSub(sub);
    toast("Notifications are on for this phone");
    return true;
  } catch (e) { toast("Could not turn on notifications: " + friendly(e)); return false; }
}
async function syncPush() { // keep the server copy fresh (endpoint can change)
  try { if ((await pushState()) !== "on") return; const reg = await swReady(); const sub = await reg.pushManager.getSubscription(); if (sub) await saveSub(sub); } catch { /* ignore */ }
}
async function disablePushHere() {
  try {
    const reg = await swReady(); const sub = await reg.pushManager.getSubscription();
    if (sub) { await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
  } catch { /* ignore */ }
}

/* ───────────── shell ───────────── */
function route() { const h = (location.hash || "#dash").slice(1); const [name, arg] = h.split("/"); return { name: name || "dash", arg }; }
function go(h) { if (location.hash === "#" + h) rerender(); else location.hash = h; }
function shell() {
  if ($("#main")) return;
  $("#app").innerHTML = `
    <header class="top"><div class="top-in">
      <div class="brand">${esc(C.COMPANY_NAME || "Floor Task Board")}<small id="deptLine"></small></div>
      <div class="who"><b id="meName"></b><span id="meRole"></span></div>
    </div></header>
    <main id="main"></main>
    <nav class="tabbar" aria-label="Main"><div class="tabbar-in" id="tabbar"></div></nav>`;
}
function renderHeader() {
  $("#deptLine").textContent = S.depts.join(" · ");
  $("#meName").textContent = S.me.name;
  $("#meRole").textContent = { admin: "Admin", manager: "Manager", staff: S.me.dept || "Staff" }[S.me.role];
}
function renderTabbar() {
  const r = route().name, unread = S.alerts.filter((a) => !a.read_at).length;
  const tab = (h, icon, label, on, extra = "") => `<a href="#${h}" class="${on ? "on" : ""} ${extra}" aria-current="${on ? "page" : "false"}">${icon}<span>${label}</span></a>`;
  $("#tabbar").innerHTML =
    tab("dash", svg("home"), "Home", r === "dash") +
    tab("tasks", svg("list"), "Tasks", r === "tasks" || r === "task") +
    (isMgr() ? `<a href="#new" class="plus ${r === "new" ? "on" : ""}" aria-label="New task"><span class="circle">${svg("plus")}</span></a>` : "") +
    `<a href="#alerts" class="${r === "alerts" ? "on" : ""}">${svg("bell")}<span>Alerts</span>${unread ? `<span class="dot">${unread > 99 ? "99+" : unread}</span>` : ""}</a>` +
    tab(isAdmin() ? "team" : "me", svg(isAdmin() ? "team" : "user"), isAdmin() ? "Team" : "Me", r === "team" || r === "me");
}
function rerender() {
  if (!S.me) return renderLogin();
  shell(); renderHeader(); renderTabbar();
  const { name, arg } = route();
  S.openTaskId = name === "task" ? arg : null;
  const views = { dash: viewDash, tasks: viewTasks, task: () => viewTask(arg), new: () => viewForm(), edit: () => viewForm(arg), team: viewTeam, alerts: viewAlerts, me: viewMe };
  (views[name] || viewDash)();
}
const main = () => $("#main");

/* ───────────── login ───────────── */
function renderLogin() {
  unsubscribe();
  const otp = !!C.ENABLE_MOBILE_OTP;
  const mode = renderLogin.mode || "user";
  $("#app").innerHTML = `
  <div class="login">
    <header class="top"><div class="top-in"><div class="brand">${esc(C.COMPANY_NAME || "Floor Task Board")}<small>Factory · Godown · Office</small></div></div></header>
    <main>
      <h1 class="h-page">Log in</h1>
      <div class="seg" role="group" aria-label="Login method">
        <button data-mode="user" aria-pressed="${mode === "user"}">Username</button>
        <button data-mode="email" aria-pressed="${mode === "email"}">Email</button>
        ${otp ? `<button data-mode="otp" aria-pressed="${mode === "otp"}">Mobile OTP</button>` : ""}
      </div>
      <form id="loginForm" class="panel" novalidate>
        ${mode === "user" ? `
          <div class="field"><label for="lUser">Username</label><input id="lUser" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="e.g. ramesh" required></div>
          <div class="field"><label for="lPin">PIN</label><input id="lPin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="6-digit PIN" required></div>`
        : mode === "email" ? `
          <div class="field"><label for="lEmail">Email</label><input id="lEmail" type="email" autocomplete="email" autocapitalize="none" required></div>
          <div class="field"><label for="lPass">Password or PIN</label><input id="lPass" type="password" autocomplete="current-password" required></div>`
        : `
          <div class="field"><label for="lPhone">Mobile number</label><input id="lPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="98XXXXXXXX" required></div>
          <div class="field" id="otpField" hidden><label for="lOtp">OTP</label><input id="lOtp" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code"></div>`}
        <div class="err" id="lErr" role="alert"></div>
        <button class="btn primary block" id="lBtn" type="submit">${mode === "otp" ? "Send OTP" : "Log in"}</button>
      </form>
      <p class="muted small">Don't have a login? Ask your admin to add you in the Team screen.</p>
    </main>
  </div>`;
  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { renderLogin.mode = b.dataset.mode; renderLogin(); }));
  let otpSent = false, phone = "";
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#lBtn"), err = $("#lErr");
    err.textContent = ""; btn.disabled = true;
    try {
      if (mode === "user") {
        const r = await fetch(`${C.SUPABASE_URL}/functions/v1/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: C.SUPABASE_ANON_KEY, Authorization: `Bearer ${C.SUPABASE_ANON_KEY}` },
          body: JSON.stringify({ username: $("#lUser").value.trim(), pin: $("#lPin").value }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Wrong username or PIN.");
        const { error } = await sb.auth.setSession(j);
        if (error) throw error;
      } else if (mode === "email") {
        const { error } = await sb.auth.signInWithPassword({ email: $("#lEmail").value.trim(), password: $("#lPass").value });
        if (error) throw new Error(/invalid/i.test(error.message) ? "Wrong email or password." : error.message);
      } else if (!otpSent) {
        phone = normPhone($("#lPhone").value);
        if (!phone) throw new Error("Enter your 10-digit mobile number.");
        const { error } = await sb.auth.signInWithOtp({ phone, options: { shouldCreateUser: false } });
        if (error) throw new Error(/not found|signups/i.test(error.message) ? "This number is not registered. Ask your admin." : error.message);
        otpSent = true; $("#otpField").hidden = false; $("#lOtp").focus(); btn.textContent = "Verify and log in";
        btn.disabled = false; return;
      } else {
        const { error } = await sb.auth.verifyOtp({ phone, token: $("#lOtp").value.trim(), type: "sms" });
        if (error) throw new Error("Wrong or expired OTP.");
      }
      $("#app").innerHTML = '<div class="boot">Loading…</div>';
      await loadAll();
      if (!location.hash || location.hash === "#login") location.hash = "dash";
      rerender();
    } catch (e2) { err.textContent = friendly(e2); btn.disabled = false; }
  });
}
function normPhone(v) {
  const d = String(v || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.length === 10) return "+91" + d;
  if (d.length === 12 && d.startsWith("91")) return "+" + d;
  return null;
}

/* ───────────── dashboard ───────────── */
function scopeTasks() { return isMgr() ? S.tasks : S.tasks.filter((t) => t.assignee === S.me.id || t.assigned_by === S.me.id); }
async function viewDash() {
  const now = Date.now(), all = scopeTasks(), pend = all.filter((t) => t.status !== "done");
  const over = pend.filter((t) => ms(t.due) < now), soonT = pend.filter((t) => ms(t.due) >= now && ms(t.due) - now < D);
  const prog = pend.filter((t) => t.status === "progress");
  const done7 = all.filter((t) => t.status === "done" && ms(t.done_at) > now - 7 * D);
  const done30 = all.filter((t) => t.status === "done" && ms(t.done_at) > now - 30 * D);
  const ontime = done30.filter((t) => ms(t.done_at) <= ms(t.due)).length;
  const rate = done30.length ? Math.round((ontime / done30.length) * 100) : null;
  const h = new Date().getHours();
  const hello = (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening") + ", " + S.me.name.split(" ")[0];
  const line = !all.length ? (isMgr() ? "No tasks yet. Tap + to assign the first one." : "No tasks for you yet.")
    : over.length ? `${over.length} task${over.length > 1 ? "s are" : " is"} past the deadline.`
    : soonT.length ? `All on time. ${soonT.length} due in the next 24 hours.` : "Everything is on schedule.";
  const kpi = (cls, l, n, s, view) => `<button class="kpi ${cls}" data-view="${view}"><span class="l">${l}</span><span class="n">${n}</span><span class="s">${s}</span></button>`;
  const att = [...over, ...soonT].sort((a, b) => ms(a.due) - ms(b.due)).slice(0, 6);

  let deptHtml = "", peopleHtml = "";
  if (isMgr()) {
    deptHtml = S.depts.map((d) => {
      const dp = pend.filter((t) => t.dept === d), dl = dp.filter((t) => ms(t.due) < now).length,
        ds = dp.filter((t) => ms(t.due) >= now && ms(t.due) - now < D).length, df = dp.length - dl - ds,
        dd = done7.filter((t) => t.dept === d).length, tot = dp.length + dd || 1, pc = (n) => ((n / tot) * 100).toFixed(1) + "%";
      return `<button class="dcard" data-dept="${esc(d)}"><span class="dn">${esc(d)}</span><span class="dv">${dp.length}<small>pending</small></span>
        <span class="bar"><i class="c-late" style="width:${pc(dl)}"></i><i class="c-soon" style="width:${pc(ds)}"></i><i class="c-fine" style="width:${pc(df)}"></i><i class="c-done" style="width:${pc(dd)}"></i></span>
        <span class="dleg">${dl ? `<span style="color:var(--late)"><b>${dl}</b> late</span>` : ""}${ds ? `<span style="color:var(--soon)"><b>${ds}</b> due soon</span>` : ""}<span><b>${dd}</b> done this week</span></span></button>`;
    }).join("");
    const ppl = S.profiles.filter((p) => p.active).map((p) => {
      const mine = pend.filter((t) => t.assignee === p.id);
      return { p, n: mine.length, o: mine.filter((t) => ms(t.due) < now).length };
    }).filter((x) => x.n).sort((a, b) => b.o - a.o || b.n - a.n).slice(0, 8);
    const mx = Math.max(1, ...ppl.map((x) => x.n));
    peopleHtml = ppl.length ? ppl.map((x) => `<div class="person"><span class="pn">${esc(x.p.name)}<small>${esc(x.p.dept || "")}</small></span>
      <span class="bar" style="height:10px"><i class="c-late" style="width:${((x.o / mx) * 100).toFixed(1)}%"></i><i class="c-fine" style="width:${(((x.n - x.o) / mx) * 100).toFixed(1)}%"></i></span>
      <span class="pv">${x.n} pending${x.o ? ` · <b>${x.o} late</b>` : ""}</span></div>`).join("")
      : `<div class="empty">Nobody has pending work.</div>`;
  }

  // last 7 days chart
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const days = [...Array(7)].map((_, i) => day0.getTime() - (6 - i) * D);
  const A = days.map((d) => all.filter((t) => ms(t.created_at) >= d && ms(t.created_at) < d + D).length);
  const Cc = days.map((d) => all.filter((t) => t.status === "done" && ms(t.done_at) >= d && ms(t.done_at) < d + D).length);
  const top = Math.ceil(Math.max(2, ...A, ...Cc) / 2) * 2;
  const W = 600, Hh = 200, L = 30, B = 26, T = 10, R = 6, cw = (W - L - R) / 7, bw = Math.min(18, cw / 3.2), y = (v) => T + (Hh - T - B) * (1 - v / top);
  let chart = `<svg class="chart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Tasks assigned and completed per day, last 7 days">`;
  [0, top / 2, top].forEach((v) => { chart += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"${v ? ' stroke-dasharray="3 4"' : ""}/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" font-family="IBM Plex Mono,monospace" fill="var(--muted)">${v}</text>`; });
  days.forEach((d, i) => {
    const cx = L + cw * i + cw / 2;
    chart += `<rect x="${cx - bw - 2}" y="${y(A[i])}" width="${bw}" height="${y(0) - y(A[i])}" rx="3" fill="var(--accent)"><title>${A[i]} assigned</title></rect>`;
    chart += `<rect x="${cx + 2}" y="${y(Cc[i])}" width="${bw}" height="${y(0) - y(Cc[i])}" rx="3" fill="var(--ok)"><title>${Cc[i]} completed</title></rect>`;
    chart += `<text x="${cx}" y="${Hh - 8}" text-anchor="middle" font-size="11.5" fill="${i === 6 ? "var(--ink)" : "var(--muted)"}" font-weight="${i === 6 ? 600 : 400}" font-family="IBM Plex Sans,sans-serif">${i === 6 ? "Today" : new Date(d).toLocaleDateString("en-IN", { weekday: "short" })}</text>`;
  });
  chart += "</svg>";

  const ps = await pushState();
  const pushBanner = ps === "on" ? "" : ps === "ios-install"
    ? `<div class="banner warn"><p><b>Get alerts on this iPhone:</b> tap the Share button, choose <b>Add to Home Screen</b>, then open the app from your home screen.</p></div>`
    : ps === "denied" ? `<div class="banner bad"><p>Notifications are blocked for this app. Allow them in your phone's settings to get new tasks and deadline alerts.</p></div>`
    : ps === "unsupported" ? "" : `<div class="banner"><p><b>Turn on notifications</b> to get new tasks and deadline reminders on this phone.</p><button class="btn primary small" id="pushOn">Turn on</button></div>`;

  if (route().name !== "dash") return;
  main().innerHTML = `
    ${pushBanner}
    <div class="greet"><h1>${esc(hello)}</h1><p>${esc(line)}</p></div>
    <div class="kpis">
      ${kpi(over.length ? "alert" : "", "Overdue", over.length, over.length ? "Past deadline" : "Nothing late", "overdue")}
      ${kpi("warn", "Due in 24 hrs", soonT.length, "Today or tomorrow", "soon")}
      ${kpi("prog", "In progress", prog.length, `of ${pend.length} pending`, "pending")}
      ${kpi("good", "Done this week", done7.length, "Last 7 days", "done")}
      ${kpi("", "On-time rate", rate === null ? "—" : rate + "%", rate === null ? "Nothing finished yet" : `${ontime} of ${done30.length} in 30 days`, "done")}
    </div>
    <div class="dgrid">
      <section class="panel"><div class="panel-head"><h2 class="h-sec">Needs attention</h2><button class="link" data-view="overdue">All overdue</button></div>
        <div class="list" style="border:none">${att.length ? att.map(taskRow).join("") : `<div class="empty"><strong style="color:var(--ok)">All clear</strong>Nothing overdue or due in the next 24 hours.</div>`}</div>
      </section>
      ${isMgr() ? `<section class="panel"><div class="panel-head"><h2 class="h-sec">Departments</h2><span class="muted small">Pending work</span></div><div class="depts">${deptHtml}</div></section>` : ""}
      <section class="panel"><div class="panel-head"><h2 class="h-sec">Last 7 days</h2><div class="legend"><span><i style="background:var(--accent)"></i>Assigned</span><span><i style="background:var(--ok)"></i>Done</span></div></div>${chart}</section>
      ${isMgr() ? `<section class="panel"><div class="panel-head"><h2 class="h-sec">Team workload</h2><span class="muted small">pending · <b style="color:var(--late);font-weight:500">late</b></span></div><div class="people">${peopleHtml}</div></section>` : ""}
    </div>`;
  $("#pushOn")?.addEventListener("click", async () => { if (await enablePush()) viewDash(); });
  main().querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => { S.f.view = b.dataset.view; S.f.dept = "All"; saveFilters(); go("tasks"); }));
  main().querySelectorAll("[data-dept]").forEach((b) => b.addEventListener("click", () => { S.f.view = "pending"; S.f.dept = b.dataset.dept; saveFilters(); go("tasks"); }));
}

/* ───────────── task list ───────────── */
function taskRow(t) {
  const tl = timeLeft(t), st = t.status;
  return `<a class="trow" href="#task/${t.id}">
    <span class="tt">${esc(t.title)}</span>
    <span class="tr"><span class="left ${tl.cls}">${esc(tl.txt)}</span><span class="st st-${st}">${STATUS[st]}</span></span>
    <span class="tm">${t.dept ? `<span class="dept">${esc(t.dept)}</span>` : ""}<span>${esc(pname(t.assignee))}</span><span class="mono">${fmt(t.due)}</span>${t.priority === "high" ? '<span class="hi">High</span>' : ""}</span>
  </a>`;
}
function viewTasks() {
  const now = Date.now(), f = S.f;
  const base = scopeTasks().filter((t) => (f.dept === "All" || t.dept === f.dept) && (!f.mine || t.assignee === S.me.id)
    && (!f.q || (t.title + " " + t.details + " " + pname(t.assignee)).toLowerCase().includes(f.q.toLowerCase())));
  const tests = {
    pending: (t) => t.status !== "done",
    overdue: (t) => t.status !== "done" && ms(t.due) < now,
    soon: (t) => t.status !== "done" && ms(t.due) >= now && ms(t.due) - now < D,
    done: (t) => t.status === "done",
    all: () => true,
  };
  const views = [["pending", "Pending"], ["overdue", "Overdue"], ["soon", "Due soon"], ["done", "Done"], ["all", "All"]];
  const rows = base.filter(tests[f.view] || tests.pending)
    .sort(f.view === "done" ? (a, b) => ms(b.done_at) - ms(a.done_at) : (a, b) => ms(a.due) - ms(b.due));
  main().innerHTML = `
    <div class="panel-head"><h1 class="h-page">Tasks</h1>${isMgr() ? '<a class="btn primary small" href="#new">New task</a>' : ""}</div>
    <input id="q" type="search" placeholder="Search tasks or people" value="${esc(f.q)}" aria-label="Search">
    <div class="chips" role="group" aria-label="Status">${views.map(([k, l]) => `<button class="chip" data-v="${k}" aria-pressed="${f.view === k}">${l}<span class="n">${base.filter(tests[k]).length}</span></button>`).join("")}</div>
    ${isMgr() ? `<div class="chips" role="group" aria-label="Department">${["All", ...S.depts].map((d) => `<button class="chip" data-d="${esc(d)}" aria-pressed="${f.dept === d}">${esc(d)}</button>`).join("")}
      <button class="chip" id="mineChip" aria-pressed="${f.mine}">Only mine</button></div>` : ""}
    <div class="list">${rows.length ? rows.map(taskRow).join("") : `<div class="empty"><strong>Nothing here</strong>${S.tasks.length ? "No tasks match this filter." : isMgr() ? "Tap New task to assign the first job." : "No tasks for you yet."}</div>`}</div>`;
  main().querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => { f.view = b.dataset.v; saveFilters(); viewTasks(); }));
  main().querySelectorAll("[data-d]").forEach((b) => b.addEventListener("click", () => { f.dept = b.dataset.d; saveFilters(); viewTasks(); }));
  $("#mineChip")?.addEventListener("click", () => { f.mine = !f.mine; saveFilters(); viewTasks(); });
  const q = $("#q"); let qt;
  q.addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(() => { f.q = q.value; viewTasks(); const n = $("#q"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); });
}

/* ───────────── task detail ───────────── */
async function viewTask(id, quiet) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t) { main().innerHTML = `<a class="back" href="#tasks">‹ Tasks</a><div class="empty"><strong>Task not found</strong>It may have been deleted.</div>`; return; }
  if (!quiet) main().innerHTML = `<a class="back" href="#tasks">‹ Tasks</a><div class="empty">Loading…</div>`;
  const { data: notes } = await sb.from("followups").select("*").eq("task_id", id).order("created_at", { ascending: false });
  if (route().name !== "task" || route().arg !== id) return;
  const draft = $("#fuText")?.value || "";
  const tl = timeLeft(t), canStatus = isMgr() || t.assignee === S.me.id;
  main().innerHTML = `
    <a class="back" href="#tasks">‹ Tasks</a>
    <section class="panel">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${t.dept ? `<span class="dept">${esc(t.dept)}</span>` : ""}<span class="st st-${t.status}">${STATUS[t.status]}</span>${t.priority === "high" ? '<span class="hi">High priority</span>' : ""}</div>
      <h1 class="h-page" style="text-transform:none;letter-spacing:.01em">${esc(t.title)}</h1>
      <div class="facts">
        <div class="fact"><div class="k">Deadline</div><div class="v mono">${fmtLong(t.due)}</div><span class="left ${tl.cls}" style="display:inline-block;margin-top:4px">${esc(tl.txt)}</span></div>
        <div class="fact"><div class="k">Assigned to</div><div class="v">${esc(pname(t.assignee))}</div></div>
        <div class="fact"><div class="k">Assigned by</div><div class="v">${esc(pname(t.assigned_by))}</div><div class="muted small">${fmt(t.created_at)}</div></div>
      </div>
      ${t.details ? `<div class="desc">${esc(t.details)}</div>` : ""}
    </section>
    ${canStatus ? `<section class="panel"><h2 class="h-sec">Status</h2>
      <div class="seg" role="group" aria-label="Status">${["open", "progress", "done"].map((s) => `<button data-status="${s}" aria-pressed="${t.status === s}">${STATUS[s]}</button>`).join("")}</div>
      ${isMgr() ? `<h2 class="h-sec" style="margin-top:6px">Deadline</h2><div class="row-actions">
        <button class="btn small" data-ext="2">+2 hrs</button><button class="btn small" data-ext="24">+1 day</button><button class="btn small" data-ext="72">+3 days</button>
        <a class="btn small" href="#edit/${t.id}">Edit task</a><button class="btn small danger" id="delBtn">Delete</button></div>` : ""}
    </section>` : ""}
    <section class="panel"><h2 class="h-sec">Follow-ups</h2>
      <form id="fuForm" class="row-actions" style="flex-direction:column">
        <textarea id="fuText" rows="2" maxlength="1000" placeholder="e.g. Spoke to Ramesh, 40 cartons counted, rest by evening">${esc(draft)}</textarea>
        <div class="row-actions end"><button class="btn primary small" type="submit">Add follow-up</button></div>
      </form>
      <ul class="log">${(notes || []).map((n) => `<li><span class="lt">${fmt(n.created_at)} · ${esc(pname(n.author))}</span><p>${esc(n.note)}</p></li>`).join("") || '<li class="muted">No follow-ups yet.</li>'}</ul>
    </section>`;

  const addNote = (note) => sb.from("followups").insert({ task_id: id, note, author: S.me.id });
  main().querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", async () => {
    const s = b.dataset.status; if (s === t.status) return;
    const { error } = await sb.from("tasks").update({ status: s }).eq("id", id);
    if (error) return toast(friendly(error));
    await addNote(s === "done" ? "Marked as done" : `Status changed to ${STATUS[s]}`);
    await refreshTasks(); viewTask(id, true); toast("Status updated");
  }));
  main().querySelectorAll("[data-ext]").forEach((b) => b.addEventListener("click", async () => {
    const nd = new Date(Math.max(ms(t.due), Date.now()) + +b.dataset.ext * H).toISOString();
    const { error } = await sb.from("tasks").update({ due: nd }).eq("id", id);
    if (error) return toast(friendly(error));
    await addNote(`Deadline moved to ${fmtLong(nd)}`);
    await refreshTasks(); viewTask(id, true); toast("Deadline moved");
  }));
  $("#delBtn")?.addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to delete"; return; }
    const { error } = await sb.from("tasks").delete().eq("id", id);
    if (error) return toast(friendly(error));
    S.tasks = S.tasks.filter((x) => x.id !== id); toast("Task deleted"); go("tasks");
  });
  $("#fuForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ta = $("#fuText"), note = ta.value.trim(); if (!note) return ta.focus();
    const { error } = await addNote(note);
    if (error) return toast(friendly(error));
    ta.value = ""; viewTask(id, true); toast("Follow-up added");
  });
}

/* ───────────── new / edit task ───────────── */
function viewForm(id) {
  if (!isMgr()) return go("dash");
  const t = id ? S.tasks.find((x) => x.id === id) : null;
  if (id && !t) return go("tasks");
  const active = S.profiles.filter((p) => p.active);
  const def = new Date(Date.now() + D); def.setMinutes(0, 0, 0);
  const dept = t ? t.dept : S.f.dept !== "All" ? S.f.dept : S.me.dept || S.depts[0];
  main().innerHTML = `
    <a class="back" href="${t ? "#task/" + t.id : "#tasks"}">‹ ${t ? "Back" : "Tasks"}</a>
    <h1 class="h-page">${t ? "Edit task" : "New task"}</h1>
    <form id="tf" class="panel">
      <div class="field"><label for="fTitle">Task</label><input id="fTitle" required maxlength="200" placeholder="e.g. Count Godown 14 adult pants stock" value="${esc(t?.title || "")}"></div>
      <div class="field"><label for="fDetails">Details</label><textarea id="fDetails" rows="3" placeholder="What exactly needs to be done">${esc(t?.details || "")}</textarea></div>
      <div class="grid2">
        <div class="field"><label for="fDept">Department</label><select id="fDept">${S.depts.map((d) => `<option ${d === dept ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></div>
        <div class="field"><label for="fWho">Assign to</label><select id="fWho" required></select></div>
      </div>
      <div class="grid2">
        <div class="field"><label for="fDue">Deadline</label><input id="fDue" type="datetime-local" required value="${toLocalInput(t ? t.due : def)}"></div>
        <div class="field"><label for="fPrio">Priority</label><select id="fPrio"><option value="normal">Normal</option><option value="high" ${t?.priority === "high" ? "selected" : ""}>High</option></select></div>
      </div>
      <div class="row-actions" id="quickDue">
        <button type="button" class="chip" data-q="2h">In 2 hrs</button><button type="button" class="chip" data-q="eod">Today 6 PM</button>
        <button type="button" class="chip" data-q="tom">Tomorrow 12 PM</button><button type="button" class="chip" data-q="3d">In 3 days</button>
      </div>
      <p class="muted small" style="margin:0">${t ? "If you change the person or deadline, they get a fresh notification and reminders." : "The person gets a notification right away, plus reminders before the deadline."}</p>
      <div class="err" id="fErr"></div>
      <button class="btn primary block" type="submit" id="fBtn">${t ? "Save changes" : "Assign task"}</button>
    </form>`;
  const fillWho = (d, sel) => {
    const inDept = active.filter((p) => p.dept === d), rest = active.filter((p) => p.dept !== d);
    $("#fWho").innerHTML = '<option value="">Choose a person</option>' +
      (inDept.length ? `<optgroup label="${esc(d)}">${inDept.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</optgroup>` : "") +
      (rest.length ? `<optgroup label="Others">${rest.map((p) => `<option value="${p.id}">${esc(p.name)} · ${esc(p.dept || "")}</option>`).join("")}</optgroup>` : "");
    if (sel) $("#fWho").value = sel;
  };
  fillWho(dept, t?.assignee);
  $("#fDept").addEventListener("change", (e) => fillWho(e.target.value));
  $("#quickDue").addEventListener("click", (e) => {
    const b = e.target.closest("[data-q]"); if (!b) return;
    const d = new Date();
    if (b.dataset.q === "2h") d.setTime(Date.now() + 2 * H);
    if (b.dataset.q === "eod") d.setHours(18, 0, 0, 0);
    if (b.dataset.q === "tom") { d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); }
    if (b.dataset.q === "3d") { d.setDate(d.getDate() + 3); d.setHours(18, 0, 0, 0); }
    $("#fDue").value = toLocalInput(d);
  });
  $("#tf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#fErr"), btn = $("#fBtn"); err.textContent = "";
    const body = {
      title: $("#fTitle").value.trim(), details: $("#fDetails").value.trim(), dept: $("#fDept").value,
      assignee: $("#fWho").value || null, due: new Date($("#fDue").value).toISOString(), priority: $("#fPrio").value,
    };
    if (!body.title) return (err.textContent = "Enter what needs to be done.");
    if (!body.assignee) return (err.textContent = "Choose who should do it.");
    if (!t && ms(body.due) < Date.now()) return (err.textContent = "The deadline is in the past. Pick a later time.");
    btn.disabled = true;
    const res = t ? await sb.from("tasks").update(body).eq("id", t.id).select().single() : await sb.from("tasks").insert(body).select().single();
    btn.disabled = false;
    if (res.error) return (err.textContent = friendly(res.error));
    await refreshTasks();
    toast(t ? "Task updated" : `Task sent to ${pname(body.assignee)}`);
    go("task/" + res.data.id);
  });
}

/* ───────────── alerts ───────────── */
async function viewAlerts() {
  const ps = await pushState();
  if (route().name !== "alerts") return;
  const pushCard = ps === "on"
    ? `<div class="banner" style="background:var(--ok-bg);color:var(--ok)"><p>Notifications are on for this phone.</p><button class="btn small" id="testPush">Send a test</button></div>`
    : ps === "ios-install" ? `<div class="banner warn"><p><b>iPhone:</b> tap Share → <b>Add to Home Screen</b>, then open the app from your home screen to turn on alerts.</p></div>`
    : ps === "denied" ? `<div class="banner bad"><p>Notifications are blocked. Allow them for this app in your phone settings.</p></div>`
    : ps === "unsupported" ? `<div class="banner warn"><p>This browser can't show notifications. Use Chrome on Android or Safari on iPhone.</p></div>`
    : `<div class="banner"><p>Turn on notifications to get alerts on this phone.</p><button class="btn primary small" id="pushOn">Turn on</button></div>`;
  const unread = S.alerts.filter((a) => !a.read_at).length;
  main().innerHTML = `
    <div class="panel-head"><h1 class="h-page">Alerts</h1>${unread ? '<button class="link" id="readAll">Mark all read</button>' : ""}</div>
    ${pushCard}
    <section class="panel"><div class="nlist">${S.alerts.length ? S.alerts.map((a) => `
      <button class="nitem ${a.read_at ? "read" : ""}" data-id="${a.id}" data-task="${a.task_id || ""}">
        <span class="nd k-${esc(a.kind)}"></span><span class="nt">${esc(a.title)}</span><span class="nb">${esc(a.body)}</span><span class="nw">${ago(a.created_at)}</span>
      </button>`).join("") : `<div class="empty"><strong>No alerts yet</strong>New tasks, follow-ups and deadline reminders will show here.</div>`}</div></section>`;
  $("#pushOn")?.addEventListener("click", async () => { if (await enablePush()) viewAlerts(); });
  $("#testPush")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try { const r = await fnCall("notify", { type: "test" }); toast(r.sent ? "Test sent. It should arrive in a few seconds." : "No phone registered yet. Turn notifications off and on again."); }
    catch (err) { toast(friendly(err)); }
  });
  $("#readAll")?.addEventListener("click", async () => {
    const now = new Date().toISOString();
    await sb.from("notifications").update({ read_at: now }).eq("user_id", S.me.id).is("read_at", null);
    S.alerts.forEach((a) => { if (!a.read_at) a.read_at = now; }); renderTabbar(); viewAlerts();
  });
  main().querySelectorAll(".nitem").forEach((b) => b.addEventListener("click", async () => {
    const a = S.alerts.find((x) => String(x.id) === b.dataset.id);
    if (a && !a.read_at) { a.read_at = new Date().toISOString(); sb.from("notifications").update({ read_at: a.read_at }).eq("id", a.id).then(() => {}); }
    if (b.dataset.task && S.tasks.some((t) => t.id === b.dataset.task)) go("task/" + b.dataset.task); else { renderTabbar(); viewAlerts(); }
  }));
}

/* ───────────── me / settings ───────────── */
async function viewMe() {
  const ps = await pushState();
  if (route().name !== "me") return;
  main().innerHTML = `
    ${isAdmin() ? '<a class="back" href="#team">‹ Team</a>' : ""}
    <h1 class="h-page">${esc(S.me.name)}</h1>
    <section class="panel"><div class="facts">
      <div class="fact"><div class="k">Department</div><div class="v">${esc(S.me.dept || "—")}</div></div>
      <div class="fact"><div class="k">Role</div><div class="v">${esc({ admin: "Admin", manager: "Manager", staff: "Staff" }[S.me.role])}</div></div>
      <div class="fact"><div class="k">Username</div><div class="v mono">${esc(S.me.username || "—")}</div></div>
    </div></section>
    <section class="panel"><h2 class="h-sec">Notifications on this phone</h2>
      <p class="muted" style="margin:0">${ps === "on" ? "On. You'll get new tasks and deadline reminders here." : ps === "ios-install" ? "On iPhone, first add this app to your Home Screen (Share → Add to Home Screen) and open it from there." : ps === "denied" ? "Blocked. Allow notifications for this app in your phone settings." : ps === "unsupported" ? "Not supported in this browser." : "Off."}</p>
      <div class="row-actions">${ps === "off" ? '<button class="btn primary" id="pushOn">Turn on notifications</button>' : ""}${ps === "on" ? '<button class="btn" id="testPush">Send a test</button><button class="btn" id="pushOff">Turn off on this phone</button>' : ""}</div>
    </section>
    <section class="panel"><h2 class="h-sec">Change PIN</h2>
      <form id="pinForm" class="grid2">
        <div class="field"><label for="p1">New PIN or password</label><input id="p1" type="password" inputmode="numeric" autocomplete="new-password" minlength="6" required></div>
        <div class="field"><label for="p2">Type it again</label><input id="p2" type="password" inputmode="numeric" autocomplete="new-password" minlength="6" required></div>
        <div class="row-actions"><button class="btn" type="submit">Save new PIN</button></div>
      </form>
    </section>
    <button class="btn danger block" id="logout">Log out</button>`;
  $("#pushOn")?.addEventListener("click", async () => { if (await enablePush()) viewMe(); });
  $("#pushOff")?.addEventListener("click", async () => { await disablePushHere(); toast("Notifications turned off for this phone"); viewMe(); });
  $("#testPush")?.addEventListener("click", async () => {
    try { const r = await fnCall("notify", { type: "test" }); toast(r.sent ? "Test sent" : "No phone registered yet."); } catch (e) { toast(friendly(e)); }
  });
  $("#pinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const a = $("#p1").value, b = $("#p2").value;
    if (a.length < 6) return toast("Use at least 6 digits.");
    if (a !== b) return toast("The two PINs don't match.");
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) return toast(friendly(error));
    e.target.reset(); toast("PIN changed");
  });
  $("#logout").addEventListener("click", async () => {
    await disablePushHere();
    await sb.auth.signOut();
    S.me = null; S.tasks = []; S.alerts = [];
    location.hash = "login"; renderLogin();
  });
}

/* ───────────── team (admin) ───────────── */
function viewTeam() {
  if (!isMgr()) return go("me");
  const groups = [...S.depts, ""].map((d) => [d, S.profiles.filter((p) => (p.dept || "") === d)]).filter(([, l]) => l.length);
  main().innerHTML = `
    <div class="panel-head"><h1 class="h-page">Team</h1><a class="link" href="#me">My account ›</a></div>
    ${isAdmin() ? `<section class="panel"><h2 class="h-sec">Add a person</h2>
      <form id="addForm" class="grid2">
        <div class="field"><label for="aName">Name</label><input id="aName" required maxlength="60" placeholder="e.g. Ramesh Patel"></div>
        <div class="field"><label for="aUser">Username</label><input id="aUser" required autocapitalize="none" spellcheck="false" placeholder="e.g. ramesh"><span class="hint">Used to log in. No spaces.</span></div>
        <div class="field"><label for="aPin">PIN</label><input id="aPin" required inputmode="numeric" minlength="6" placeholder="6 digits"><span class="hint">Tell them this PIN. They can change it later.</span></div>
        <div class="field"><label for="aDept">Department</label><select id="aDept">${S.depts.map((d) => `<option>${esc(d)}</option>`).join("")}</select></div>
        <div class="field"><label for="aRole">Role</label><select id="aRole"><option value="staff">Staff (gets tasks)</option><option value="manager">Manager (assigns tasks)</option><option value="admin">Admin (manages team)</option></select></div>
        <div class="field"><label for="aPhone">Mobile (optional)</label><input id="aPhone" type="tel" placeholder="For OTP login"></div>
        <div class="field" style="grid-column:1/-1"><label for="aEmail">Email (optional)</label><input id="aEmail" type="email" autocapitalize="none" placeholder="For email login"></div>
        <div class="err" id="aErr" style="grid-column:1/-1"></div>
        <div class="row-actions" style="grid-column:1/-1"><button class="btn primary" type="submit" id="aBtn">Add person</button></div>
      </form></section>` : ""}
    <div id="editBox"></div>
    ${groups.map(([d, list]) => `<section class="team-group"><h2 class="h-sec">${esc(d || "No department")} <span class="muted small">${list.length}</span></h2>
      ${list.map((p) => `<button class="member ${p.active ? "" : "off"}" data-id="${p.id}" ${isAdmin() ? "" : "disabled"}>
        <span><span class="mn">${esc(p.name)}${p.id === S.me.id ? " (you)" : ""}</span><br><span class="mm">${p.username ? "@" + esc(p.username) : "no username"}${p.phone ? " · " + esc(p.phone) : ""}${p.active ? "" : " · deactivated"}</span></span>
        <span class="role ${p.role}">${p.role}</span></button>`).join("")}</section>`).join("")}
    ${isAdmin() ? `<section class="panel"><h2 class="h-sec">Departments</h2><p class="muted" style="margin:0">${esc(S.depts.join(", "))}</p>
      <form id="deptForm" class="row-actions"><input id="dName" maxlength="40" placeholder="New department, e.g. Dispatch" style="flex:1 1 200px" aria-label="New department"><button class="btn" type="submit">Add</button></form></section>` : ""}`;

  $("#addForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#aErr"), btn = $("#aBtn"); err.textContent = ""; btn.disabled = true;
    try {
      await fnCall("admin-users", {
        action: "create", name: $("#aName").value.trim(), username: $("#aUser").value.trim().toLowerCase(), pin: $("#aPin").value,
        dept: $("#aDept").value, role: $("#aRole").value, phone: $("#aPhone").value.trim() || undefined, email: $("#aEmail").value.trim() || undefined,
      });
      const u = $("#aUser").value.trim().toLowerCase();
      e.target.reset();
      const { data } = await sb.from("profiles").select("*").order("name"); if (data) S.profiles = data;
      viewTeam(); toast(`Added. Username: ${u}`);
    } catch (e2) { err.textContent = friendly(e2); btn.disabled = false; }
  });
  $("#deptForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#dName").value.trim(); if (!name) return;
    const { error } = await sb.from("departments").insert({ name, sort: S.depts.length + 1 });
    if (error) return toast(/duplicate/i.test(error.message) ? "That department already exists." : friendly(error));
    S.depts.push(name); renderHeader(); viewTeam(); toast(name + " added");
  });
  main().querySelectorAll(".member[data-id]").forEach((b) => b.addEventListener("click", () => editPerson(b.dataset.id)));
}
function editPerson(id) {
  const p = person(id); if (!p) return;
  const box = $("#editBox");
  box.innerHTML = `<section class="panel" style="border-color:var(--accent)">
    <div class="panel-head"><h2 class="h-sec">Edit ${esc(p.name)}</h2><button class="link" id="eClose">Close</button></div>
    <form id="eForm" class="grid2">
      <div class="field"><label for="eName">Name</label><input id="eName" value="${esc(p.name)}" required></div>
      <div class="field"><label for="eUser">Username</label><input id="eUser" value="${esc(p.username || "")}" autocapitalize="none" spellcheck="false"></div>
      <div class="field"><label for="eDept">Department</label><select id="eDept">${S.depts.map((d) => `<option ${d === p.dept ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></div>
      <div class="field"><label for="eRole">Role</label><select id="eRole">${["staff", "manager", "admin"].map((r) => `<option value="${r}" ${r === p.role ? "selected" : ""}>${r[0].toUpperCase() + r.slice(1)}</option>`).join("")}</select></div>
      <div class="field"><label for="ePin">New PIN</label><input id="ePin" inputmode="numeric" placeholder="Leave empty to keep"></div>
      <div class="field"><label for="ePhone">Mobile</label><input id="ePhone" type="tel" value="${esc(p.phone || "")}"></div>
      <div class="err" id="eErr" style="grid-column:1/-1"></div>
      <div class="row-actions" style="grid-column:1/-1">
        <button class="btn primary" type="submit">Save</button>
        ${p.id !== S.me.id ? `<button class="btn ${p.active ? "danger" : ""}" type="button" id="eActive">${p.active ? "Deactivate" : "Reactivate"}</button>` : ""}
      </div>
    </form></section>`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#eClose").addEventListener("click", () => (box.innerHTML = ""));
  const save = async (extra) => {
    try {
      await fnCall("admin-users", { action: "update", id, ...extra });
      const { data } = await sb.from("profiles").select("*").order("name"); if (data) S.profiles = data;
      if (id === S.me.id) S.me = person(id);
      viewTeam(); toast("Saved");
    } catch (e) { $("#eErr").textContent = friendly(e); }
  };
  $("#eForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const body = { name: $("#eName").value.trim(), username: $("#eUser").value.trim(), dept: $("#eDept").value, role: $("#eRole").value };
    if ($("#ePin").value) body.pin = $("#ePin").value;
    if ($("#ePhone").value.trim() !== (p.phone || "")) body.phone = $("#ePhone").value.trim();
    save(body);
  });
  $("#eActive")?.addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (p.active && b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to deactivate"; return; }
    save({ active: !p.active });
  });
}

/* ───────────── boot ───────────── */
async function boot() {
  if (!C.SUPABASE_URL || /YOUR-/.test(C.SUPABASE_URL + C.SUPABASE_ANON_KEY)) {
    $("#app").innerHTML = `<main style="padding:40px 16px;max-width:520px;margin:0 auto"><h1 class="h-page">Almost there</h1><p>Open <b>docs/config.js</b> and fill in your Supabase URL, anon key and VAPID public key (see README, step 7).</p></main>`;
    return;
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.open) location.href = e.data.open; });
  }
  sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT" && S.me) { S.me = null; renderLogin(); } });
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await loadAll();
  } catch (e) { toast(friendly(e)); }
  window.addEventListener("hashchange", rerender);
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && S.me) { await refreshTasks(); await refreshAlerts(); rerender(); }
  });
  setInterval(() => { // keep "time left" labels current
    if (!S.me) return;
    const r = route().name;
    if ((r === "dash" || r === "tasks") && !document.activeElement?.matches("input,textarea,select")) rerender();
  }, 60000);
  rerender();
}
boot();
