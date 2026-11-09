// BAH – Business Automation Hub: one browser portal for employees and administrators (role decided by the database). No frameworks, no third-party code.
// Talks directly to the Supabase project's Auth / REST / Edge Function APIs with the PUBLIC key; every row is filtered
// by row-level security in the database (employees: own records only). No service-role key, no SAP passwords.
// All page text is set with textContent (never innerHTML with data).
"use strict";

const PROJECT = "https://tffiatipkehzizaciigv.supabase.co";
const KEY = "sb_publishable_edgku1tj5w_zvD1ZPby5lg_SIg-mE4J";   // public key (identifies the project only)
const AUTH = `${PROJECT}/auth/v1`, REST = `${PROJECT}/rest/v1`, FN = `${PROJECT}/functions/v1`;
const app = document.getElementById("app");
let session = null, me = null, tab = "tasks";
const mainArea = () => document.getElementById("main") || app;     // page content (inside the shell)

// ------------------------------------------------------------------ tiny DOM helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const fmt = (t) => (t ? new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }) : "—");
// Same badge colours as the local BAH portal (core.js BADGES).
const BADGES = { active: "ok", succeeded: "ok", passed: "ok", online: "ok", paused: "warn", waiting_retry: "warn",
  passed_with_warnings: "warn", pending: "info", claimed: "info", failed: "bad", inactive: "", revoked: "bad",
  cancelled: "", offline: "", queued: "info", sending: "info", sent: "ok", invalid: "bad", lease_expired: "bad",
  delivered: "ok", delivered_to_junk: "warn", bounced: "bad", not_confirmed: "warn", available: "ok",
  authorised: "ok", enabled: "ok", "not authorised": "", "not enabled": "", "accepted by mail server": "ok" };
function badge(s) {
  const cls = BADGES[s] ?? (/online|on PC/.test(s || "") ? "ok" : /no password|offline/.test(s || "") ? "warn" : "");
  return h("span", { class: `badge ${cls}`, text: String(s || "—").replaceAll("_", " ") });
}
function pageHead(title, sub, ...actions) {
  return h("div", { class: "page-head" }, h("h1", { text: title }), h("div", { class: "actions" }, actions),
    sub ? h("div", { class: "sub", text: sub }) : null);
}
const BRAND = (small) => h("div", { class: "brand" }, h("img", { src: "logo.svg", alt: "" }),
  h("div", {}, "BAH – Business Automation Hub", small ? h("small", { text: small }) : null));
const ROLE_LABEL = () => (me && me.is_admin ? "Administrator" : "Employee");
// One sign-in page for everyone: nothing about any person or role is shown before sign-in.
function authPanel(title, form, ...extra) {
  app.replaceChildren(h("div", { class: "auth" }, h("div", { class: "panel" }, BRAND(""), h("h1", { text: title }), form, ...extra)));
}

// ------------------------------------------------------------------ session (tab-scoped storage)
function saveSession(s) {
  session = s ? { access_token: s.access_token, refresh_token: s.refresh_token,
                  expires_at: Date.now() + (s.expires_in || 3600) * 1000 } : null;
  try { session ? sessionStorage.setItem("bah", JSON.stringify(session)) : sessionStorage.removeItem("bah"); } catch { /* private mode */ }
}
async function authPost(path, body, token) {
  const r = await fetch(`${AUTH}${path}`, { method: "POST", headers: { apikey: KEY, "content-type": "application/json",
                                                                       ...(token ? { authorization: `Bearer ${token}` } : {}) },
                                            body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || j.message || "Sign-in failed");
  return j;
}
async function token() {
  if (!session) throw new Error("signed out");
  if (Date.now() > session.expires_at - 60000) {
    try { saveSession(await authPost("/token?grant_type=refresh_token", { refresh_token: session.refresh_token })); }
    catch { signOutLocal(); throw new Error("Session expired - please sign in again"); }
  }
  return session.access_token;
}
async function api(path, opts = {}) {
  const r = await fetch(`${REST}${path}`, { ...opts, headers: { apikey: KEY, authorization: `Bearer ${await token()}`,
    "accept-profile": "bah", "content-profile": "bah", "content-type": "application/json", ...(opts.headers || {}) } });
  if (r.status === 401) { signOutLocal(); throw new Error("Session expired - please sign in again"); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.message) || `Request failed (${r.status})`);
  return j;
}
function signOutLocal() { saveSession(null); me = null; renderLogin(); }

// ------------------------------------------------------------------ screens
function renderLogin(message) {
  const email = h("input", { type: "email", autocomplete: "username", required: true });
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true });
  const err = h("div", { class: "error", text: message || "" });
  const btn = h("button", { class: "primary", text: "Sign in" });
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; err.textContent = "";
    try { saveSession(await authPost("/token?grant_type=password", { email: email.value.trim().toLowerCase(), password: pw.value }));
          pw.value = ""; await start(); }
    catch (x) { err.textContent = x.message.includes("not active") ? x.message : "E-mail or password incorrect, or account not active."; }
    finally { btn.disabled = false; }
  } }, h("label", { class: "field" }, "E-mail", email), h("label", { class: "field" }, "Password", pw),
     btn, err, h("p", { class: "hint", text: "Forgot your password? Ask the BAH administrator for a new one-time link." }));
  authPanel("Sign in", form); email.focus();
}

function renderSetPassword(accessToken) {
  const p1 = h("input", { type: "password", autocomplete: "new-password", minlength: "12", required: true });
  const p2 = h("input", { type: "password", autocomplete: "new-password", minlength: "12", required: true });
  const err = h("div", { class: "error" });
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    if (p1.value !== p2.value) { err.textContent = "Passwords differ."; return; }
    if (p1.value.length < 12 || !/[A-Za-z]/.test(p1.value) || !/[0-9]/.test(p1.value)) { err.textContent = "At least 12 characters with letters and digits."; return; }
    const r = await fetch(`${AUTH}/user`, { method: "PUT", headers: { apikey: KEY, authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
                                           body: JSON.stringify({ password: p1.value }) });
    p1.value = p2.value = "";
    if (!r.ok) { err.textContent = "The link has expired or the password was refused. Ask the administrator for a new link."; return; }
    await fetch(`${AUTH}/logout`, { method: "POST", headers: { apikey: KEY, authorization: `Bearer ${accessToken}` } }).catch(() => {});
    renderLogin("Password set. Sign in with your official e-mail and the new password.");
  } }, h("label", { class: "field" }, "New password (min. 12, letters and digits)", p1),
     h("label", { class: "field" }, "Repeat", p2), h("button", { class: "primary", text: "Save password" }), err);
  authPanel("Set your BAH password", form);
}

async function start() {
  me = await api("/rpc/caller_context", { method: "POST", body: "{}" });
  const prof = (await api(`/profiles?select=full_name,email,role&id=eq.${me.user_id}`))[0];
  if (!prof || me.status !== "active") { signOutLocal(); renderLogin("Account not active for BAH."); return; }
  me.full_name = prof.full_name;
  tab = me.is_admin ? "admin_dashboard" : "dashboard";        // land on the dashboard for the user's role
  render();
}

// Navigation: same sections, labels and layout as the local BAH portal (static/js/admin.js / employee.js nav).
// [key, label, subtitle] - a string entry is a section heading.
const TABS = ["My work", ["dashboard", "My Dashboard", "Your tasks, recent runs and report e-mails at a glance."],
  ["tasks", "My Tasks", "Your report tasks, schedules and next runs."],
  ["runs", "Execution History", "Every run of your tasks."], ["reports", "Reports", "Validated workbooks available to download."],
  ["notifications", "E-mail Notifications", "Report e-mails sent by the cloud BAH for your tasks."],
  "Account", ["runner", "BAH Runner", "Download, install and update the BAH Runner on your PC."]];

function layout(nav) {
  const signOut = async () => {
    try { await fetch(`${AUTH}/logout?scope=local`, { method: "POST", headers: { apikey: KEY, authorization: `Bearer ${session.access_token}` } }); } catch { /* ignore */ }
    signOutLocal();
  };
  return h("div", { class: "shell" },
    h("header", { class: "topbar" }, BRAND(me.is_admin ? "Administrator dashboard" : "Employee dashboard"),
      h("div", { class: "spacer" }), h("span", { class: "cloudflag", text: "CLOUD" }),
      h("div", { class: "userbox" }, h("span", { text: me.full_name }), h("span", { class: "role", text: ROLE_LABEL() }),
        h("button", { class: "small", text: "Sign out", onclick: signOut }))),
    h("nav", { class: "sidebar" }, nav.map((n) => typeof n === "string" ? h("div", { class: "section", text: n })
      : h("a", { class: n[0] === tab ? "active" : "", text: n[1], href: "#", onclick: (e) => { e.preventDefault(); tab = n[0]; render(); } }))),
    h("main", { id: "main" }));
}

// A view returns either a list of nodes, or { actions: [buttons for the page header], content: [nodes] }.
async function render() {
  const nav = me.is_admin && typeof ADMIN_TABS !== "undefined" ? ADMIN_TABS : TABS;
  const items = nav.filter((n) => typeof n !== "string");
  if (!items.some(([k]) => k === tab)) tab = items[0][0];
  const [, title, sub] = items.find(([k]) => k === tab);
  app.replaceChildren(layout(nav));
  const body = h("div", {}, pageHead(title, sub), h("div", { class: "empty", text: "Loading…" }));
  mainArea().append(body);
  const view = VIEWS[tab] || (me.is_admin && ADMIN_VIEWS[tab]);
  try {
    const out = await view();
    const paged = !Array.isArray(out);
    body.replaceChildren(pageHead(title, sub, ...(paged ? out.actions || [] : [])), ...(paged ? out.content : out));
  } catch (x) { body.replaceChildren(pageHead(title, sub), h("div", { class: "notice warn", text: x.message })); }
}

function table(cols, rows, empty) {
  if (!rows.length) return [h("div", { class: "tablewrap" }, h("div", { class: "empty", text: empty }))];
  return [h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, cols.map(([l]) => h("th", { text: l })))),
            h("tbody", {}, rows.map((r) => h("tr", {}, cols.map(([, f]) => h("td", {}, f(r) ?? "—")))))))];
}
// Same wording as the local BAH (catalog.schedule_summary).
const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const schedText = (s) => {
  if (!s || s.status === "inactive") return "No schedule (manual only)";
  const when = { daily: "Daily", weekly: `Weekly on ${WEEKDAYS[s.weekday || 0]}`, fortnightly: `Every 14 days from ${s.anchor_date}`,
                 monthly: s.last_day_of_month ? "Monthly on the last day" : `Monthly on day ${s.month_day}` }[s.frequency] || s.frequency;
  return `${when} at ${s.run_time.slice(0, 5)} Asia/Karachi${s.status === "paused" ? " (paused)" : ""}`;
};
// Same type badges as the local BAH. Live SAP tasks are executed by the LOCAL BAH on their schedule; the cloud never runs them.
const TARGETS = { synthetic: ["Synthetic", "info"], fixture: ["Fixture", "warn"], live_sap: ["LIVE SAP", "bad"] };
const targetBadge = (t) => h("span", { class: `badge ${(TARGETS[t] || ["", ""])[1]}`, text: (TARGETS[t] || [t])[0] });

// Next scheduled run (same rules as the database scheduler, Asia/Karachi = UTC+5, no DST). Live SAP is never scheduled.
function nextRun(t) {
  const s = (t.schedules || [])[0];
  if (!s || s.status !== "active" || t.status !== "active" || t.execution_mode === "manual_only") return "Not scheduled";
  const [hh, mm] = s.run_time.split(":").map(Number);
  const now = Date.now(), dayMs = 86400000;
  const k0 = new Date(now + 5 * 3600000);                       // Karachi wall clock
  let d = Date.UTC(k0.getUTCFullYear(), k0.getUTCMonth(), k0.getUTCDate());
  for (let i = 0; i < 400; i++, d += dayMs) {
    const day = new Date(d), dow = ((day.getUTCDay() + 6) % 7) + 1;
    const last = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
    const ok = s.frequency === "daily" || (s.frequency === "weekly" && dow === s.weekday)
      || (s.frequency === "fortnightly" && s.anchor_date && d >= Date.parse(s.anchor_date) && Math.round((d - Date.parse(s.anchor_date)) / dayMs) % 14 === 0)
      || (s.frequency === "monthly" && (s.last_day_of_month ? day.getUTCDate() === last : day.getUTCDate() === Math.min(s.month_day, last)));
    const at = d + (hh * 60 + mm) * 60000 - 5 * 3600000;        // Karachi time -> UTC
    if (ok && at > now) return fmt(new Date(at).toISOString()) + (t.execution_target === "live_sap" ? " (local BAH)" : "");
  }
  return "—";
}

async function taskDetail(t) {
  const runs = await api(`/occurrences?select=id,kind,status,due_at,attempts,max_attempts,completed_at,executions(attempt_no,status,started_at,finished_at,row_count,column_count,validation_status,error_class,error_detail,engine),report_files(id,file_name,status)&task_id=eq.${t.id}&order=due_at.desc&limit=50`);
  const back = h("button", { class: "secondary", text: "Back", onclick: () => render() });
  const body = h("div", {}, pageHead(t.name, t.description || "", back),
    h("div", { class: "card" }, h("dl", { class: "dl" },
      h("dt", { text: "Status" }), h("dd", {}, badge(t.status)), h("dt", { text: "Type" }), h("dd", {}, targetBadge(t.execution_target)),
      h("dt", { text: "Execution mode" }), h("dd", { text: t.execution_mode.replaceAll("_", " ") }),
      h("dt", { text: "Schedule" }), h("dd", { text: schedText((t.schedules || [])[0]) }),
      h("dt", { text: "Next run" }), h("dd", { text: nextRun(t) }))),
    h("div", { class: "card" }, h("h2", { text: "Execution history" }),
    ...table([["Due", (o) => fmt(o.due_at)], ["Type", (o) => o.kind], ["Status", (o) => badge(o.status)],
              ["Attempts", (o) => (o.executions || []).sort((a, b) => a.attempt_no - b.attempt_no).map((e) =>
                 h("div", {}, `#${e.attempt_no} `, badge(e.status), ` ${fmt(e.started_at)} → ${fmt(e.finished_at)}`,
                   e.row_count != null ? ` · ${e.row_count} rows × ${e.column_count} cols` : "",
                   e.error_class ? h("div", { class: "muted", text: `${e.error_class}${e.error_detail ? " - " + e.error_detail : ""}` }) : null))],
              ["Report", (o) => (o.report_files || []).filter((f) => f.status === "available").map((f) =>
                 h("button", { class: "secondary", text: "Download", onclick: (e) => download(f.id, e.target) }))]],
             runs, "No runs yet.")));
  mainArea().replaceChildren(body);
}

// Employee dashboard (same card/KPI layout as the admin dashboard; RLS limits every query to the user's own rows).
async function employeeDashboard() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const [tasks, occ, mails, runners, latestRows] = await Promise.all([
    api("/tasks?select=id,status"), api(`/occurrences?select=status,kind,due_at,tasks(name)&due_at=gte.${since}&order=due_at.desc&limit=200`),
    api(`/notifications?select=status&created_at=gte.${since}`),
    api(`/runners?select=name,version,last_seen_at&status=eq.active&employee_id=eq.${me.user_id}`),
    api("/rpc/release_latest_stable", { method: "POST", body: "{}" }).catch(() => [])]);
  const n = (rows, f) => rows.filter(f).length;
  const kpi = (label, value, cls = "") => h("div", { class: `kpi ${cls}` }, h("div", { class: "label", text: label }), h("div", { class: "value", text: String(value) }));
  const group = (title, ...k) => h("div", { class: "card" }, h("h2", { text: title }), h("div", { class: "kpis" }, ...k));
  const r = runners[0] || null, [state, cls] = runnerState(r && r.version, (latestRows || [])[0] || null);
  return [
    h("div", { class: "grid2" },
      group("My tasks", kpi("Assigned tasks", tasks.length), kpi("Active", n(tasks, (t) => t.status === "active"), "ok")),
      group("My runner", kpi("Runner", r ? r.name : "not set up", r ? "ok" : "warn"), kpi("Version", r ? String(r.version || "—").replace(/^cloud-/, "") : "—", cls),
        kpi("Status", r ? state : "see BAH Runner", cls))),
    h("div", { class: "grid2" },
      group("Runs - last 7 days", kpi("Success", n(occ, (o) => o.status === "succeeded"), "ok"), kpi("Failed", n(occ, (o) => o.status === "failed"), "bad"),
        kpi("Queued", n(occ, (o) => ["pending", "waiting_retry", "claimed"].includes(o.status)), "warn")),
      group("Report e-mails - last 7 days", kpi("Sent", n(mails, (m) => m.status === "sent"), "ok"),
        kpi("Queued", n(mails, (m) => ["queued", "sending"].includes(m.status)), "warn"), kpi("Failed", n(mails, (m) => m.status === "failed"), "bad"))),
    h("div", { class: "card" }, h("h2", { text: "Recent runs" }),
      ...table([["Task", (o) => (o.tasks || {}).name || "—"], ["Type", (o) => o.kind === "relay" ? "local BAH run" : o.kind],
                ["Due", (o) => fmt(o.due_at)], ["Status", (o) => badge(o.status)]], occ.slice(0, 10), "No runs in the last 7 days."))];
}

const VIEWS = {
  dashboard: employeeDashboard,
  runner: runnerPage,
  async tasks() {
    const rows = await api("/tasks?select=id,name,description,execution_target,execution_mode,status,schedules(frequency,run_time,weekday,month_day,last_day_of_month,anchor_date,status)&order=name");
    return table([["Task", (t) => h("div", {}, h("strong", { text: t.name }), t.description ? h("div", { class: "muted", text: t.description }) : null)],
                  ["Schedule", (t) => schedText((t.schedules || [])[0])],
                  ["Next run", (t) => nextRun(t)],
                  ["Type", (t) => targetBadge(t.execution_target)],
                  ["Status", (t) => badge(t.status)],
                  ["", (t) => h("button", { class: "secondary", text: "Details", onclick: () => taskDetail(t) })]],
                 rows, "No tasks are assigned to you yet.");
  },
  async runs() {
    const rows = await api("/occurrences?select=id,kind,status,due_at,attempts,max_attempts,completed_at,tasks(name),executions(attempt_no,status,finished_at,row_count,validation_status,error_class)&order=due_at.desc&limit=100");
    return table([["Task", (o) => (o.tasks || {}).name || "—"],
                  ["Due", (o) => fmt(o.due_at)],
                  ["Type", (o) => o.kind],
                  ["Status", (o) => badge(o.status)],
                  ["Last attempt", (o) => { const e = (o.executions || []).sort((a, b) => b.attempt_no - a.attempt_no)[0];
                    return e ? h("div", {}, badge(e.status), ` ${e.row_count ?? ""}${e.row_count != null ? " rows" : ""}`,
                                 e.error_class ? h("div", { class: "muted", text: e.error_class }) : null) : "not started"; }],
                  ["Attempts", (o) => `${o.attempts} / ${o.max_attempts}`]], rows, "No task runs yet.");
  },
  async reports() {
    const rows = await api("/report_files?select=id,file_name,size_bytes,uploaded_at,retain_until,status,occurrences(due_at,tasks(name))&status=eq.available&order=uploaded_at.desc&limit=100");
    return table([["Report", (f) => h("div", {}, h("strong", { text: ((f.occurrences || {}).tasks || {}).name || "—" }), h("div", { class: "muted", text: f.file_name }))],
                  ["Created", (f) => fmt(f.uploaded_at)],
                  ["Size", (f) => `${Math.max(1, Math.round(f.size_bytes / 1024))} KB`],
                  ["Kept until", (f) => fmt(f.retain_until)],
                  ["", (f) => h("button", { class: "secondary", text: "Download", onclick: (e) => download(f.id, e.target) })]],
                 rows, "No reports available yet.");
  },
  async notifications() {
    const rows = await api("/notifications?select=kind,status,created_at,sent_at,delivery_status,error_class,tasks(name)&order=created_at.desc&limit=100");
    return table([["Task", (n) => (n.tasks || {}).name || "—"],
                  ["Type", (n) => n.kind === "success" ? "Report e-mail" : "Failure notice"],
                  ["Queued", (n) => fmt(n.created_at)],
                  ["E-mail", (n) => h("div", {}, badge(n.status === "sent" ? "accepted by mail server" : n.status),
                                      n.error_class ? h("div", { class: "muted", text: n.error_class }) : null)],
                  ["Mailbox", (n) => n.delivery_status ? badge(n.delivery_status) : "not checked"]], rows, "No notifications yet.");
  },
};

// ------------------------------------------------------------------ BAH Runner (generic package, versions)
const RELEASE_BUCKET = "bah-runner-releases";
const vkey = (v) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(v || "").replace(/^cloud-/, ""));
                      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]; };
const vcmp = (a, b) => { const x = vkey(a), y = vkey(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
function runnerState(installed, latest) {
  if (!installed) return ["not installed", ""];
  if (!latest) return ["no release published", ""];
  if (latest.min_supported_version && vcmp(installed, latest.min_supported_version) < 0) return ["unsupported - update now", "bad"];
  return vcmp(installed, latest.version) < 0 ? [`update available (${latest.version})`, "warn"] : ["up to date", "ok"];
}
// Short-lived download link signed by Storage for THIS session (the bucket policy allows stable packages only).
async function releaseDownload(path, btn) {
  btn.disabled = true;
  try {
    const r = await fetch(`${PROJECT}/storage/v1/object/sign/${RELEASE_BUCKET}/${path}`, { method: "POST",
      headers: { apikey: KEY, authorization: `Bearer ${await token()}`, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: 300 }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.signedURL) throw new Error("This package is not available for download.");
    window.location.assign(`${PROJECT}/storage/v1${j.signedURL}`);
  } catch (x) { alert(x.message); } finally { btn.disabled = false; }
}
const REQUIREMENTS = ["Windows 10 or 11 (64-bit), your normal Windows user (no administrator rights needed)",
  "Internet access to the BAH cloud; office network or Kerio VPN to reach SAP", "About 1 GB free disk space (Python, browser, reports)",
  "Your BAH portal account, and your SAP user ID registered by the BAH administrator"];
const INSTALL = ["Download the package below and unzip it (e.g. into Downloads).", "Double-click Install-BAH-Runner.cmd - it installs everything for your Windows user.",
  "First installation only: BAH Runner Setup opens - sign in with your BAH account, confirm your SAP user ID and type your SAP password (stored only in Windows Credential Manager on your PC).",
  "Start the runner from the Start menu: Start BAH Runner. Keep the window open while you work.",
  "Updates: use Update BAH Runner (or install the new package the same way) - your registration and SAP password are kept."];

async function runnerPage() {
  const [latestRows, mine] = await Promise.all([api("/rpc/release_latest_stable", { method: "POST", body: "{}" }),
    api(`/runners?select=name,version,last_seen_at,status&status=eq.active&employee_id=eq.${me.user_id}`)]);
  const latest = (latestRows || [])[0] || null, r = mine[0] || null;
  const [state, cls] = runnerState(r && r.version, latest);
  const dl = latest ? h("button", { class: "primary", text: `Download BAH Runner ${latest.version}`, onclick: (e) => releaseDownload(latest.object_path, e.target) }) : null;
  return { actions: dl ? [dl] : [], content: [
    h("div", { class: "grid2" },
      h("div", { class: "card" }, h("h2", { text: "Latest version" }), latest
        ? h("dl", { class: "dl" }, h("dt", { text: "Version" }), h("dd", { text: latest.version }),
            h("dt", { text: "Release date" }), h("dd", { text: latest.release_date }),
            h("dt", { text: "Package" }), h("dd", { text: `${latest.file_name} (${Math.max(1, Math.round(latest.size_bytes / 1024))} KB)` }),
            h("dt", { text: "SHA-256" }), h("dd", { class: "mono", text: latest.sha256 }),
            latest.min_supported_version ? h("dt", { text: "Minimum supported" }) : null,
            latest.min_supported_version ? h("dd", { text: latest.min_supported_version }) : null)
        : h("div", { class: "empty", text: "No BAH Runner release is published yet." })),
      h("div", { class: "card" }, h("h2", { text: "Your PC" }), r
        ? h("dl", { class: "dl" }, h("dt", { text: "Runner" }), h("dd", { text: r.name }),
            h("dt", { text: "Installed version" }), h("dd", { text: String(r.version || "—").replace(/^cloud-/, "") }),
            h("dt", { text: "Update status" }), h("dd", {}, h("span", { class: `badge ${cls}`, text: state })),
            h("dt", { text: "Last seen" }), h("dd", { text: fmt(r.last_seen_at) }))
        : h("div", { class: "empty", text: "No BAH Runner is registered for you yet - install it with the steps below." }))),
    latest ? h("div", { class: "card" }, h("h2", { text: "What's new" }), h("div", { class: "prewrap", text: latest.notes || "—" })) : null,
    h("div", { class: "grid2" },
      h("div", { class: "card" }, h("h2", { text: "Installation" }), h("ol", {}, INSTALL.map((t) => h("li", { text: t })))),
      h("div", { class: "card" }, h("h2", { text: "System requirements" }), h("ul", {}, REQUIREMENTS.map((t) => h("li", { text: t })))))
  ].filter(Boolean) };
}

async function download(id, btn) {
  btn.disabled = true;
  try {
    const r = await fetch(`${FN}/report-download`, { method: "POST", headers: { apikey: KEY, authorization: `Bearer ${await token()}`,
                                                                              "content-type": "application/json" },
                                                     body: JSON.stringify({ report_file_id: id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error("This report is not available to you.");
    window.location.assign(j.url);                      // 5-minute signed link, audited by the database
  } catch (x) { alert(x.message); } finally { btn.disabled = false; }
}

// ------------------------------------------------------------------ boot
(function boot() {
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get("access_token") && (frag.get("type") === "recovery" || frag.get("type") === "invite")) {
    const t = frag.get("access_token");
    history.replaceState(null, "", location.pathname);   // remove the one-time token from the address bar
    renderSetPassword(t);
    return;
  }
  if (frag.get("error_description")) {
    history.replaceState(null, "", location.pathname);
    renderLogin("This link is invalid or has expired. Ask the administrator for a new one.");
    return;
  }
  try { session = JSON.parse(sessionStorage.getItem("bah") || "null"); } catch { session = null; }
  if (session) start().catch(() => signOutLocal()); else renderLogin();
})();
