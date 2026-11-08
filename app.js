// PE BAH - browser portal for employees and the administrator. No frameworks, no third-party code.
// Talks directly to the Supabase project's Auth / REST / Edge Function APIs with the PUBLIC key; every row is filtered
// by row-level security in the database (employees: own records only). No service-role key, no SAP passwords.
// All page text is set with textContent (never innerHTML with data).
"use strict";

const PROJECT = "https://tffiatipkehzizaciigv.supabase.co";
const KEY = "sb_publishable_edgku1tj5w_zvD1ZPby5lg_SIg-mE4J";   // public key (identifies the project only)
const AUTH = `${PROJECT}/auth/v1`, REST = `${PROJECT}/rest/v1`, FN = `${PROJECT}/functions/v1`;
const app = document.getElementById("app"), who = document.getElementById("who");
let session = null, me = null, tab = "tasks";

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
function badge(s) {
  const cls = /succeeded|passed|sent|delivered|active|available/.test(s || "") ? "ok"
            : /failed|cancelled|bounced|invalid|lease_expired/.test(s || "") ? "bad" : "warn";
  return h("span", { class: `badge ${cls}`, text: s || "—" });
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
function signOutLocal() { saveSession(null); me = null; who.hidden = true; renderLogin(); }

// ------------------------------------------------------------------ screens
function renderLogin(message) {
  who.hidden = true;
  const email = h("input", { type: "email", autocomplete: "username", required: true });
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true });
  const err = h("div", { class: "err", text: message || "" });
  const btn = h("button", { text: "Sign in" });
  const form = h("form", { class: "card login", onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; err.textContent = "";
    try { saveSession(await authPost("/token?grant_type=password", { email: email.value.trim().toLowerCase(), password: pw.value }));
          pw.value = ""; await start(); }
    catch (x) { err.textContent = x.message.includes("not active") ? x.message : "E-mail or password incorrect, or account not active."; }
    finally { btn.disabled = false; }
  } }, h("h2", { text: "Sign in" }), h("label", { text: "Official e-mail" }), email, h("label", { text: "Password" }), pw,
     h("p", {}, btn), err, h("p", { class: "muted", text: "Forgot your password? Ask the BAH administrator for a new one-time link." }));
  app.replaceChildren(form); email.focus();
}

function renderSetPassword(accessToken) {
  const p1 = h("input", { type: "password", autocomplete: "new-password", minlength: "12", required: true });
  const p2 = h("input", { type: "password", autocomplete: "new-password", minlength: "12", required: true });
  const err = h("div", { class: "err" });
  const form = h("form", { class: "card login", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    if (p1.value !== p2.value) { err.textContent = "Passwords differ."; return; }
    if (p1.value.length < 12 || !/[A-Za-z]/.test(p1.value) || !/[0-9]/.test(p1.value)) { err.textContent = "At least 12 characters with letters and digits."; return; }
    const r = await fetch(`${AUTH}/user`, { method: "PUT", headers: { apikey: KEY, authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
                                           body: JSON.stringify({ password: p1.value }) });
    p1.value = p2.value = "";
    if (!r.ok) { err.textContent = "The link has expired or the password was refused. Ask the administrator for a new link."; return; }
    await fetch(`${AUTH}/logout`, { method: "POST", headers: { apikey: KEY, authorization: `Bearer ${accessToken}` } }).catch(() => {});
    renderLogin("Password set. Sign in with your official e-mail and the new password.");
  } }, h("h2", { text: "Set your BAH password" }), h("label", { text: "New password (min. 12, letters and digits)" }), p1,
     h("label", { text: "Repeat" }), p2, h("p", {}, h("button", { text: "Save password" })), err);
  app.replaceChildren(form);
}

async function start() {
  me = await api("/rpc/caller_context", { method: "POST", body: "{}" });
  const prof = (await api(`/profiles?select=full_name,email,role&id=eq.${me.user_id}`))[0];
  if (!prof || me.status !== "active") { signOutLocal(); renderLogin("Account not active for BAH."); return; }
  me.full_name = prof.full_name;
  who.replaceChildren(h("span", { text: `${prof.full_name} · ${me.is_admin ? "Administrator" : "Employee"}` }),
    h("button", { text: "Sign out", onclick: async () => {
      try { await fetch(`${AUTH}/logout?scope=local`, { method: "POST", headers: { apikey: KEY, authorization: `Bearer ${session.access_token}` } }); } catch { /* ignore */ }
      signOutLocal(); } }));
  who.hidden = false;
  render();
}

const TABS = [["tasks", "My tasks"], ["runs", "Task status"], ["reports", "Reports"], ["notifications", "Notifications"]];
async function render() {
  const tabs = me.is_admin && typeof ADMIN_TABS !== "undefined" ? ADMIN_TABS : TABS;
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  const nav = h("nav", { class: "tabs" }, tabs.map(([k, label]) =>
    h("button", { class: k === tab ? "active" : "", text: label, onclick: () => { tab = k; render(); } })));
  const body = h("div", { class: "card" }, h("p", { class: "muted", text: "Loading…" }));
  app.replaceChildren(nav, body);
  const view = VIEWS[tab] || (me.is_admin && ADMIN_VIEWS[tab]);
  try { body.replaceChildren(...(await view())); }
  catch (x) { body.replaceChildren(h("p", { class: "err", text: x.message })); }
}

function table(cols, rows, empty) {
  if (!rows.length) return [h("p", { class: "muted", text: empty })];
  return [h("table", {}, h("thead", {}, h("tr", {}, cols.map(([l]) => h("th", { text: l })))),
            h("tbody", {}, rows.map((r) => h("tr", {}, cols.map(([, f]) => h("td", {}, f(r)))))))];
}
const schedText = (s) => !s ? "manual only" : s.frequency === "weekly" ? `weekly, day ${s.weekday}, ${s.run_time.slice(0, 5)}`
  : s.frequency === "monthly" ? `monthly, ${s.last_day_of_month ? "last day" : "day " + s.month_day}, ${s.run_time.slice(0, 5)}`
  : `${s.frequency}, ${s.run_time.slice(0, 5)}`;

const VIEWS = {
  async tasks() {
    const rows = await api("/tasks?select=id,name,description,execution_target,execution_mode,status,schedules(frequency,run_time,weekday,month_day,last_day_of_month,status)&order=name");
    return table([["Task", (t) => h("div", {}, h("strong", { text: t.name }), t.description ? h("div", { class: "muted", text: t.description }) : null)],
                  ["Mode", (t) => t.execution_mode.replaceAll("_", " ")],
                  ["Schedule", (t) => schedText((t.schedules || [])[0])],
                  ["Runs on", (t) => t.execution_target === "live_sap" ? "SAP (attended runner)" : t.execution_target],
                  ["Status", (t) => badge(t.status)]], rows, "No tasks are assigned to you yet.");
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
