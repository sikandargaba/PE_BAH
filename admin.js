// BAH - administrator screens (loaded for everyone, shown only when the database says is_admin).
// Every write goes through the REST API with the admin's own session: row-level security and the bah.admin_*
// functions decide (inactive or non-admin users are refused by the database, not by this page).
"use strict";

const DATE_RULES = ["today", "previous_day", "current_month", "previous_month", "current_week", "previous_week",
                    "rolling_7_days", "rolling_30_days", "rolling_90_days", "custom"];
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const list = (s) => String(s || "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, "").slice(0, 32);

// Same form markup as the local BAH portal (core.js field()).
function field(label, input, hint) {
  const check = input.type === "checkbox";
  return h("label", { class: check ? "field check" : "field" }, ...(check ? [input, label] : [label, input]),
    hint ? h("span", { class: "hint", text: hint }) : null);
}
const RULE_LABELS = { today: "Today (execution date)", previous_day: "Previous Day", current_month: "Current Month (to date)",
  previous_month: "Previous Month", current_week: "Current Week (to date)", previous_week: "Previous Week",
  rolling_7_days: "Rolling last 7 days", rolling_30_days: "Rolling last 30 days", rolling_90_days: "Rolling last 90 days", custom: "Custom range" };
const SYNC_NOTE = "Synchronised from the local BAH: description, execution mode, status, report parameters, e-mail settings and schedule " +
  "are maintained in the local BAH portal and overwrite this copy within 15 minutes (local wins). The local BAH runs this report; the cloud sends its e-mail.";

// ------------------------------------------------------------------ dashboard (same KPI layout as the local BAH)
async function adminDashboard() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const [people, tasks, runners, occ, mails] = await Promise.all([
    api("/profiles?select=status"), api("/tasks?select=status,execution_target"), api("/runners?select=status,last_seen_at"),
    api(`/occurrences?select=status,kind,due_at,tasks(name,description),executions(status,finished_at,row_count)&due_at=gte.${since}&order=due_at.desc&limit=200`),
    api(`/notifications?select=status,created_at&created_at=gte.${since}`)]);
  const n = (rows, f) => rows.filter(f).length;
  const kpi = (label, value, cls = "") => h("div", { class: `kpi ${cls}` }, h("div", { class: "label", text: label }), h("div", { class: "value", text: String(value) }));
  const group = (title, ...kpis) => h("div", { class: "card" }, h("h2", { text: title }), h("div", { class: "kpis" }, ...kpis));
  const online = runners.filter((r) => r.status === "active" && r.last_seen_at && Date.now() - new Date(r.last_seen_at).getTime() < 10 * 60000);
  return [
    h("div", { class: "grid2" },
      group("People & runners", kpi("Employees", people.length), kpi("Active employees", n(people, (p) => p.status === "active"), "ok"),
        kpi("Runners online", online.length, online.length ? "ok" : "warn")),
      group("Tasks", kpi("Total tasks", tasks.length), kpi("Active", n(tasks, (t) => t.status === "active"), "ok"),
        kpi("Inactive", n(tasks, (t) => t.status === "inactive")), kpi("Live SAP", n(tasks, (t) => t.execution_target === "live_sap" && t.status === "active"), "bad"))),
    h("div", { class: "grid2" },
      group("Runs - last 7 days", kpi("Success", n(occ, (o) => o.status === "succeeded"), "ok"), kpi("Failed", n(occ, (o) => o.status === "failed"), "bad"),
        kpi("Running", n(occ, (o) => o.status === "claimed")), kpi("Queued", n(occ, (o) => ["pending", "waiting_retry"].includes(o.status)), "warn")),
      group("Cloud e-mail - last 7 days", kpi("Sent", n(mails, (m) => m.status === "sent"), "ok"), kpi("Queued", n(mails, (m) => ["queued", "sending"].includes(m.status)), "warn"),
        kpi("Failed", n(mails, (m) => m.status === "failed"), "bad"))),
    h("div", { class: "card" }, h("h2", { text: "Recent execution history" }),
      ...table([["Task", (o) => repName(o.tasks)], ["Type", (o) => o.kind === "relay" ? "local BAH run" : o.kind],
                ["Due", (o) => fmt(o.due_at)], ["Status", (o) => badge(o.status)],
                ["Rows", (o) => { const e = (o.executions || [])[0]; return e && e.row_count != null ? String(e.row_count) : "—"; }]],
               occ.slice(0, 10), "No executions yet."))];
}
function inp(value, attrs = {}) { return h("input", { value: value ?? "", ...attrs }); }
function sel(value, options) {
  const s = h("select", {}, options.map(([v, l]) => h("option", { value: v, text: l })));
  s.value = value ?? options[0][0];
  return s;
}
function chk(value) { const c = h("input", { type: "checkbox" }); c.checked = !!value; return c; }
async function upsert(table, row, onConflict) {
  return api(`/${table}${onConflict ? `?on_conflict=${onConflict}` : ""}`, { method: "POST", body: JSON.stringify(row),
    headers: { prefer: "resolution=merge-duplicates,return=representation" } });
}

// ------------------------------------------------------------------ tasks (create / edit / assign / Run Now)
async function adminTasks() {
  const [tasks, people] = await Promise.all([
    api("/tasks?select=id,name,description,execution_target,execution_mode,status,task_configs(config,email),schedules(frequency,run_time,weekday,month_day,last_day_of_month,anchor_date,status),assignments(id,employee_id,status)&order=name"),
    api("/profiles?select=id,full_name,email,role,status&order=full_name")]);
  const name = (id) => (people.find((p) => p.id === id) || {}).full_name || "?";
  return { actions: [h("button", { class: "primary", text: "New task", onclick: () => editTask(null) })],
    content: table([["Description", (t) => h("div", {}, h("strong", { text: t.description || t.name }), t.description && t.description !== t.name ? h("div", { class: "muted", text: `Task: ${t.name}` }) : null)],
              ["T-Code", (t) => ((t.task_configs || {}).config || {}).tcode || "—"],
              ["Schedule", (t) => schedText((t.schedules || [])[0])],
              ["Next run", (t) => nextRun(t)],
              ["Type", (t) => targetBadge(t.execution_target)],
              ["E-mail", (t) => { const e = (t.task_configs || {}).email || {}; return e.enabled ? `${(e.to || []).length} To / ${(e.cc || []).length} CC` : "off"; }],
              ["Assignments", (t) => (t.assignments || []).filter((a) => a.status === "active").map((a) => name(a.employee_id)).join(", ") || "—"],
              ["Status", (t) => badge(t.status)],
              ["", (t) => h("div", { class: "actions" },
                 h("button", { class: "small", text: "Edit", onclick: () => editTask(t.id) }),
                 h("button", { class: "small", text: "Run Now", disabled: t.status !== "active" || t.execution_mode === "scheduled_only",
                               onclick: () => runNow(t) }))]],
             tasks, "No tasks yet - create the first one.") };
}

// ------------------------------------------------------------------ task create / edit (card layout)
// Multi-address input with removable chips. Accepts Enter, the Add button, and pasted lists separated by
// commas, semicolons, spaces or new lines. Values are stored as the same lower-case address arrays as before.
function emailChips(initial, placeholder) {
  const values = [];
  const chips = h("div", { class: "chips" });
  const msg = h("div", { class: "chip-msg" });
  const input = h("input", { type: "email", placeholder, autocomplete: "off", "aria-label": placeholder });
  const draw = () => chips.replaceChildren(...values.map((v) => h("span", { class: "chip" }, v,
    h("button", { type: "button", class: "chip-x", "aria-label": `Remove ${v}`, text: "×", onclick: () => { values.splice(values.indexOf(v), 1); draw(); } }))));
  const add = (text) => {
    const parts = String(text || "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const bad = [], dup = [];
    for (const a of parts) {
      if (!EMAIL_RE.test(a)) bad.push(a);
      else if (values.includes(a)) dup.push(a);
      else values.push(a);
    }
    draw();
    msg.textContent = bad.length ? `Not a valid e-mail address: ${bad.join(", ")}` : dup.length ? `Already added: ${dup.join(", ")}` : "";
    msg.className = bad.length ? "chip-msg error" : "chip-msg";
    input.value = bad.join(", ");
    return !bad.length;
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "," || e.key === ";") { e.preventDefault(); add(input.value); } });
  input.addEventListener("paste", (e) => { const t = (e.clipboardData || window.clipboardData).getData("text"); if (/[,;\s]/.test(t.trim())) { e.preventDefault(); add(t); } });
  input.addEventListener("blur", () => { if (input.value.trim()) add(input.value); });
  (initial || []).forEach((a) => add(a));                   // old records: arrays (or comma lists) stay editable
  msg.textContent = "";
  return { el: h("div", { class: "chip-input" }, h("div", { class: "chip-row" }, chips, input,
                   h("button", { type: "button", class: "small secondary", text: "Add", onclick: () => add(input.value) })), msg),
           values: () => { if (input.value.trim()) add(input.value); return values.slice(); }, pendingInvalid: () => !!input.value.trim() };
}

const PLACEHOLDERS = ["{report_name}", "{period_start}", "{period_end}", "{execution_date}", "{assigned_employee}", "{execution_status}"];
function placeholderBar(target) {
  return h("div", { class: "ph-bar" }, h("span", { class: "hint", text: "Insert:" }),
    PLACEHOLDERS.map((ph) => h("button", { type: "button", class: "ph", text: ph, onclick: () => {
      const a = target.selectionStart ?? target.value.length, b = target.selectionEnd ?? a;
      target.value = target.value.slice(0, a) + ph + target.value.slice(b); target.focus(); target.selectionStart = target.selectionEnd = a + ph.length;
    } })));
}

function previewEmail(o) {
  const fill = (txt) => txt.replace(/\{([a-z_]+)\}/g, (m, k) => (k in o.values ? o.values[k] : m));
  const close = () => overlay.remove();
  const row = (k, v) => [h("dt", { text: k }), h("dd", { text: v || "—" })];
  const overlay = h("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) close(); } },
    h("div", { class: "modal" }, h("header", {}, h("h3", { text: "E-mail preview (sample values)" }), h("button", { type: "button", class: "small secondary", text: "Close", onclick: close })),
      h("div", { class: "body" },
        h("dl", { class: "dl" }, row("To", o.to.join(", ")), row("CC", o.cc.join(", ")), row("BCC", o.bcc.join(", ")),
          row("Subject", o.subject ? fill(o.subject) : "(standard subject: report name and period)"),
          row("Content", { attachment: "Excel attachment", body: "Data table in the e-mail", both: "Data table and Excel attachment" }[o.format])),
        h("div", { class: "preview-body", text: o.body ? fill(o.body) : "(standard report text is used when the body is left empty)" }),
        h("p", { class: "hint", text: "Placeholders are filled with sample values here; the real e-mail uses the run's values." }))));
  document.body.append(overlay);
}

// ------------------------------------------------------------------ assigned-employees picker (searchable multi-select)
// Selection lives on each entry's `box.checked` - the flag the save logic has always read - so assignments are
// written exactly as before. Entries are { p: profile, box: { checked } }. A search matches name or e-mail
// (case-insensitive, every typed word must appear). Only the first PICKER_MAX_ROWS hits are drawn so a large
// organisation stays fast; the typed words narrow the rest.
const PICKER_MAX_ROWS = 50;
function matchEmployees(entries, query, limit = PICKER_MAX_ROWS) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length
    ? entries.filter(({ p }) => { const hay = `${p.full_name || ""} ${p.email || ""}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
    : entries;
  return { rows: hits.slice(0, limit), total: hits.length };
}
function employeePicker({ load, onLoaded, onChange }) {
  const pid = `emp-${uid()}`;
  let entries = [], ready = false, shown = [], hi = -1;
  const chips = h("div", { class: "chips" });
  const input = h("input", { type: "text", class: "emp-search", placeholder: "Search employees by name or e-mail", autocomplete: "off",
    role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": pid, "aria-label": "Search employees", disabled: true });
  const panel = h("div", { class: "emp-panel", id: pid, role: "listbox", "aria-multiselectable": "true", hidden: true });
  const status = h("div", { class: "emp-status", role: "status" });
  const chipRow = h("div", { class: "chip-row" }, chips, input);
  const root = h("div", { class: "emp-picker" }, h("div", { class: "emp-anchor" }, chipRow, panel), status);

  const setStatus = (text, error, retry) => {
    status.className = error ? "emp-status error" : "emp-status";
    status.replaceChildren(...[text, retry ? h("button", { type: "button", class: "small secondary", text: "Retry", onclick: () => start() }) : null].filter(Boolean));
  };
  const selected = () => entries.filter((x) => x.box.checked);
  const drawChips = () => chips.replaceChildren(...selected().map((x) => h("span", { class: "chip", title: x.p.email || "" }, x.p.full_name,
    h("button", { type: "button", class: "chip-x", "aria-label": `Remove ${x.p.full_name}`, text: "×", onclick: () => toggle(x, false) }))));
  const drawList = () => {
    const keep = panel.scrollTop;
    const { rows, total } = matchEmployees(entries, input.value);
    shown = rows; hi = rows.length ? Math.min(hi, rows.length - 1) : -1;
    if (hi >= 0) input.setAttribute("aria-activedescendant", `${pid}-${hi}`); else input.removeAttribute("aria-activedescendant");
    if (!rows.length) { panel.replaceChildren(h("div", { class: "emp-msg", text: `No employees match “${input.value.trim()}”.` })); return; }
    panel.replaceChildren(...[...rows.map((x, i) => h("div", { class: `emp-opt${x.box.checked ? " on" : ""}${i === hi ? " hi" : ""}`, role: "option", id: `${pid}-${i}`,
        "aria-selected": x.box.checked ? "true" : "false",
        onmousedown: (e) => e.preventDefault(),                 // keep the keyboard focus in the search box
        onclick: () => toggle(x) },
      h("span", { class: "emp-tick", "aria-hidden": "true", text: x.box.checked ? "✓" : "" }),
      h("span", { class: "emp-name" }, h("strong", { text: x.p.full_name }),
        x.p.email || x.p.role === "admin" ? h("small", { text: [x.p.email, x.p.role === "admin" ? "Administrator" : ""].filter(Boolean).join(" · ") }) : null))),
      total > rows.length ? h("div", { class: "emp-msg", text: `Showing ${rows.length} of ${total} - type more to narrow the list.` }) : null].filter(Boolean));
    panel.scrollTop = keep;
  };
  const open = () => { if (!ready) return; panel.hidden = false; input.setAttribute("aria-expanded", "true"); drawList(); };
  const close = () => { panel.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); hi = -1; };
  function toggle(x, on = !x.box.checked) { x.box.checked = on; drawChips(); if (!panel.hidden) drawList(); onChange(); }

  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("input", () => { hi = 0; open(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {                                    // never submit the whole task form from this box
      e.preventDefault();
      if (!panel.hidden && shown[hi]) toggle(shown[hi]);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (panel.hidden) { open(); return; }
      if (!shown.length) return;
      hi = e.key === "ArrowDown" ? (hi + 1) % shown.length : (hi <= 0 ? shown.length - 1 : hi - 1);
      drawList();
      const el = document.getElementById(`${pid}-${hi}`);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Escape") {
      if (!panel.hidden) { e.preventDefault(); close(); }
    } else if (e.key === "Backspace" && !input.value) {          // empty box: remove the most recent chip
      const s = selected();
      if (s.length) toggle(s[s.length - 1], false);
    }
  });
  chipRow.addEventListener("click", (e) => { if (!e.target.closest("button")) input.focus(); });
  const outside = (e) => {
    if (!root.isConnected) { document.removeEventListener("mousedown", outside); return; }   // the form was closed
    if (!root.contains(e.target)) close();
  };
  document.addEventListener("mousedown", outside);
  root.addEventListener("focusout", (e) => { if (!root.contains(e.relatedTarget)) close(); });

  async function start() {
    ready = false; input.disabled = true; close(); setStatus("Loading employees…");
    let loaded = null;
    try { loaded = await load(); } catch (e) { loaded = null; }
    if (!loaded) {
      entries = [];
      setStatus("Could not load the employee list; assignments will be left unchanged.", true, true);
    } else {
      entries = loaded; ready = entries.length > 0; input.disabled = !ready;
      setStatus(ready ? "" : "No active employees.");
    }
    onLoaded(entries, !!loaded); drawChips(); onChange();
  }
  return { el: root, start };
}

async function editTask(id) {
  const conn = (await api("/app_connections?select=id,code,display_name&status=eq.active"))[0];
  if (!conn) { alert("No active SAP connection configured."); return; }
  let t = { name: "", description: "", execution_target: "live_sap", execution_mode: "manual_only", status: "active" };
  let cfg = null;                                   // the task's OWN saved copy of the report configuration
  let em = { enabled: false, to: [], cc: [], bcc: [], subject: "", body: "", failure_subject: "", failure_body: "",
             notify_success: true, notify_failure: false, delivery_format: "attachment" };
  let sc = null, asg = [];
  const templates = await api("/report_templates?select=id,name,description,version,config,status&order=name");
  if (id) {
    t = (await api(`/tasks?select=*&id=eq.${id}`))[0];
    const c = (await api(`/task_configs?select=config,email&task_id=eq.${id}`))[0];
    if (c) { cfg = c.config || null; em = { ...em, ...c.email }; }
    sc = (await api(`/schedules?select=*&task_id=eq.${id}`))[0] || null;
    asg = await api(`/assignments?select=id,employee_id,status&task_id=eq.${id}`);
  }
  const asList = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,;]+/)).map((x) => String(x).trim()).filter(Boolean);
  const f = {
    name: inp(t.name, { maxlength: "120", required: true, placeholder: "e.g. Monthly Criticare Inventory Review" }),
    target: sel(t.execution_target, [["live_sap", "Live SAP (manual, attended)"], ["synthetic", "Synthetic (test)"], ["fixture", "Fixture (test)"]]),
    mode: sel(t.execution_mode, [["manual_only", "Manual Run Now only"], ["scheduled_and_manual", "Scheduled and manual"], ["scheduled_only", "Scheduled only"]]),
    status: sel(t.status, [["active", "Active"], ["inactive", "Inactive"], ...(t.status === "paused" ? [["paused", "Paused"]] : [])]),
    freq: sel(sc && sc.status !== "inactive" ? sc.frequency : "", [["", "No schedule (manual only)"], ["daily", "Daily"], ["weekly", "Weekly"], ["fortnightly", "Every 14 days"], ["monthly", "Monthly"]]),
    time: inp(sc ? sc.run_time.slice(0, 5) : "08:00", { type: "time" }),
    weekday: sel(sc && sc.weekday ? String(sc.weekday) : "1", [["1", "Monday"], ["2", "Tuesday"], ["3", "Wednesday"], ["4", "Thursday"], ["5", "Friday"], ["6", "Saturday"], ["7", "Sunday"]]),
    anchor: inp(sc ? sc.anchor_date : "", { type: "date" }), mday: inp(sc && sc.month_day ? sc.month_day : 1, { type: "number", min: "1", max: "31" }),
    lastday: chk(sc && sc.last_day_of_month),
    eon: chk(em.enabled),
    esub: inp(em.subject, { maxlength: "200", class: "wide", placeholder: "e.g. {report_name} - {execution_date}" }),
    ebody: h("textarea", { class: "email-body", rows: "10", placeholder: "Leave empty to use the standard report text. Use the placeholders above to insert run details." }),
    fsub: inp(em.failure_subject, { maxlength: "200", class: "wide", placeholder: "Leave empty for the standard failure subject" }),
    fbody: h("textarea", { class: "email-body short", rows: "6", placeholder: "Leave empty for the standard failure text" }),
    nsucc: chk(em.notify_success), nfail: chk(em.notify_failure),
    efmt: sel(em.delivery_format, [["attachment", "Excel attachment only"], ["body", "Data table in the e-mail body only"], ["both", "Data table and Excel attachment"]]),
  };
  f.ebody.value = em.body || ""; f.fbody.value = em.failure_body || "";
  const rTo = emailChips(asList(em.to), "name@company.com"), rCc = emailChips(asList(em.cc), "Add CC"), rBcc = emailChips(asList(em.bcc), "Add BCC");

  // ---- Report Template (the task keeps its own copy/version of the template configuration)
  const tplLabel = (x) => `${tplName(x)}${x.status === "active" ? "" : " (inactive)"}`;
  const choosable = templates.filter((x) => x.status === "active" || x.id === t.template_id);
  f.tpl = sel(t.template_id || "", [["", id && cfg ? `— ${t.description || "saved report configuration"} (no template) —` : "— choose a report —"],
                                    ...choosable.map((x) => [x.id, tplLabel(x)])]);
  const current = templates.find((x) => x.id === t.template_id);
  const upgrade = chk(false);
  let pending = null;                               // template chosen in this edit -> its configuration is copied on save
  const currentConfig = () => (pending ? tplConfig(pending) : cfg);
  // Report Name = the template Description of the configuration the task uses (its own saved snapshot).
  const reportName = () => (pending ? tplName(pending) : (cfg && cfg.report_name) || t.description || "");
  const show = () => {
    const tp = templates.find((x) => x.id === f.tpl.value);
    pending = tp && (tp.id !== t.template_id || upgrade.checked) ? tp : null;
  };
  f.tpl.addEventListener("change", () => { upgrade.checked = false; show(); });
  upgrade.addEventListener("change", show);
  show();
  const upgradeRow = current && t.template_version && current.version > t.template_version
    ? field("Use the report's latest saved configuration (this task keeps its earlier copy until ticked)", upgrade) : null;

  // ---- dynamic schedule: only the fields the frequency needs
  const sTime = field("Time (Asia/Karachi)", f.time), sWeek = field("Weekday", f.weekday), sAnchor = field("First run date", f.anchor, "Repeats every 14 days from this date"),
        sMday = field("Day of month", f.mday), sLast = field("Last day of the month", f.lastday);
  const schedHint = h("div", { class: "hint" });
  const syncSched = () => {
    const v = f.freq.value;
    const vis = { time: !!v, week: v === "weekly", anchor: v === "fortnightly", mday: v === "monthly" && !f.lastday.checked, last: v === "monthly" };
    sTime.hidden = !vis.time; sWeek.hidden = !vis.week; sAnchor.hidden = !vis.anchor; sMday.hidden = !vis.mday; sLast.hidden = !vis.last;
    schedHint.textContent = !v ? "No automatic runs; use Run Now." : f.target.value === "live_sap"
      ? "Live SAP schedules are executed by the local BAH; the cloud never runs live SAP on a schedule." : "";
  };
  for (const el of [f.freq, f.lastday, f.target]) el.addEventListener("change", syncSched);
  syncSched();

  // ---- employees: searchable multi-select, read fresh from the profiles table each time the form opens, so new or
  // newly activated employees appear without any change here. Only active employees are offered (as before);
  // the existing assignment rows still decide what is already ticked, and the save loop below is unchanged.
  let assignBoxes = [];                            // { p, a, box: { checked } } - the shape the save logic has always used
  const countBadge = h("span", { class: "badge info" });
  const syncCount = () => { const n = assignBoxes.filter((x) => x.box.checked).length; countBadge.textContent = `${n} selected`; };
  const picker = employeePicker({
    load: async () => (await api("/profiles?select=id,full_name,email,role,status&order=full_name"))
      .filter((p) => p.status === "active")
      .map((p) => { const a = asg.find((x) => x.employee_id === p.id); return { p, a, box: { checked: !!(a && a.status === "active") } }; }),
    onLoaded: (entries) => { assignBoxes = entries; save.disabled = false; },
    onChange: syncCount,
  });
  syncCount();

  // ---- e-mail on/off makes the dependent sections visibly inactive
  const emailBody = h("div", { class: "section-body" });
  const notifyBody = h("div", { class: "section-body" });
  const notifyHint = h("p", { class: "hint" });
  const syncEmail = () => {
    emailBody.classList.toggle("muted-section", !f.eon.checked);
    notifyBody.classList.toggle("muted-section", !f.eon.checked);
    notifyHint.textContent = f.eon.checked ? "E-mails go to the recipients above when a run finishes with the selected outcome."
                                           : "E-mail is switched off for this task: no notification is sent whatever is ticked here.";
  };
  f.eon.addEventListener("change", syncEmail);

  const err = h("div", { class: "err" });
  const save = h("button", { class: "primary", text: id ? "Save changes" : "Create task" });
  const preview = h("button", { type: "button", class: "secondary", text: "Preview e-mail", onclick: () => {
    const c = currentConfig() || {}, r = periodRange(c.date_rule, c.custom_from, c.custom_to);
    const d = (x) => x ? `${String(x.getUTCDate()).padStart(2, "0")}.${String(x.getUTCMonth() + 1).padStart(2, "0")}.${x.getUTCFullYear()}` : "-";
    const firstEmp = assignBoxes.find((x) => x.box.checked);
    previewEmail({ to: rTo.values(), cc: rCc.values(), bcc: rBcc.values(), subject: f.esub.value.trim(), body: f.ebody.value, format: f.efmt.value,
      values: { report_name: reportName() || "Report", task_name: reportName() || f.name.value.trim(),
                period_start: d(r && r[0]), period_end: d(r && r[1]),
                execution_date: new Date(Date.now() + 5 * 3600000).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).replace(/ /g, "-"),
                assigned_employee: firstEmp ? firstEmp.p.full_name : "Employee name", execution_status: "Succeeded", failure_reason: "-" } });
  } });

  const form = h("form", { class: "task-form", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; save.disabled = true;
    try {
      const to = rTo.values(), cc = rCc.values(), bcc = rBcc.values();
      if (rTo.pendingInvalid() || rCc.pendingInvalid() || rBcc.pendingInvalid()) throw new Error("Correct or remove the invalid e-mail addresses first.");
      if (f.eon.checked && !to.length) throw new Error("E-mail is enabled - add at least one 'To' recipient.");
      const config = currentConfig();
      if (!config) throw new Error("Choose a report name.");
      if (f.freq.value === "fortnightly" && !f.anchor.value) throw new Error("Every 14 days needs a first run date.");
      const keepTpl = !pending && f.tpl.value === (t.template_id || "");
      if (!f.name.value.trim()) throw new Error("Task name is required.");
      const row = { name: f.name.value.trim(), description: reportName() || null,
                    connection_id: conn.id, execution_target: f.target.value, execution_mode: f.mode.value, status: f.status.value,
                    template_id: pending ? pending.id : keepTpl ? (t.template_id || null) : null,
                    template_version: pending ? pending.version : keepTpl ? (t.template_version || null) : null };
      const saved = id ? (await api(`/tasks?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(row), headers: { prefer: "return=representation" } }))[0]
                       : (await api("/tasks", { method: "POST", body: JSON.stringify({ ...row, created_by: me.user_id }), headers: { prefer: "return=representation" } }))[0];
      const tid = saved.id;
      // same e-mail record as before (arrays of addresses + the existing fields), so delivery is unchanged
      const email = { ...em, enabled: f.eon.checked, to, cc, bcc, subject: f.esub.value.trim(), body: f.ebody.value, failure_subject: f.fsub.value.trim(),
                      failure_body: f.fbody.value, notify_success: f.nsucc.checked, notify_failure: f.nfail.checked,
                      delivery_format: f.efmt.value, format_version: 2 };
      await upsert("task_configs", { task_id: tid, config, email }, "task_id");
      if (f.freq.value) {
        const s = { task_id: tid, frequency: f.freq.value, run_time: f.time.value || "08:00", status: "active",
                    weekday: f.freq.value === "weekly" ? Number(f.weekday.value) : null,
                    anchor_date: f.freq.value === "fortnightly" ? (f.anchor.value || null) : null,
                    month_day: f.freq.value === "monthly" && !f.lastday.checked ? Number(f.mday.value) : null,
                    last_day_of_month: f.freq.value === "monthly" && f.lastday.checked };
        await upsert("schedules", s, "task_id");
      } else if (sc) {
        await api(`/schedules?task_id=eq.${tid}`, { method: "PATCH", body: JSON.stringify({ status: "inactive" }) });
      }
      for (const { p, a, box } of assignBoxes) {
        if (box.checked && !a) await api("/assignments", { method: "POST", body: JSON.stringify({ task_id: tid, employee_id: p.id, created_by: me.user_id }) });
        else if (a && box.checked !== (a.status === "active"))
          await api(`/assignments?id=eq.${a.id}`, { method: "PATCH", body: JSON.stringify({ status: box.checked ? "active" : "inactive" }) });
      }
      tab = "admin_tasks"; render();
    } catch (x) { err.textContent = x.message; } finally { save.disabled = false; }
  } },
    pageHead(id ? `Edit task: ${t.name}` : "New task", id ? "Report task, schedule, assignees and e-mail delivery." : "Create a report task from a report template."),
    id && t.execution_target === "live_sap" ? h("div", { class: "notice", text: SYNC_NOTE }) : null,
    h("section", { class: "card form-card" }, h("h2", { text: "1. Task details" }),
      h("div", { class: "grid-2" },
        field("Task name", f.name, "Your own name for this task."),
        field("Report name", f.tpl, "From Report Templates. Its saved SAP configuration is used; later template edits do not change this task."),
        field("Execution mode", f.mode), field("Status", f.status),
        field("Runs on", f.target, "Live SAP runs only by Run Now, attended, on the employee's own runner."),
        upgradeRow ? h("div", { class: "span-2" }, upgradeRow) : null)),
    h("section", { class: "card form-card" }, h("h2", { text: "2. Schedule" }),
      h("div", { class: "grid-3" }, field("Frequency", f.freq), sTime, sWeek, sAnchor, sMday, sLast), schedHint),
    h("section", { class: "card form-card" }, h("div", { class: "card-head" }, h("h2", { text: "3. Assigned employees" }), countBadge),
      picker.el),
    h("section", { class: "card form-card" }, h("div", { class: "card-head" }, h("h2", { text: "4. E-mail configuration" }),
        h("label", { class: "toggle" }, f.eon, " Send report e-mail")),
      emailBody),
    h("section", { class: "card form-card" }, h("h2", { text: "5. Notification settings" }),
      notifyBody),
    err,
    h("div", { class: "sticky-actions" }, h("span", { class: "hint", text: id ? "Changes apply to future runs." : "" }),
      h("div", { class: "actions" }, h("button", { type: "button", class: "secondary", text: "Cancel", onclick: () => render() }), save)));
  emailBody.append(
    h("div", { class: "grid-1" }, field("To", rTo.el), field("CC", rCc.el), field("BCC", rBcc.el, "Press Enter or Add; paste several addresses separated by commas or semicolons.")),
    h("div", { class: "grid-2" }, field("Delivery format", f.efmt), h("div", {})),
    field("Subject", f.esub, "Leave empty for the standard subject (report name and period)."),
    h("label", { class: "field" }, "Body", placeholderBar(f.ebody), f.ebody),
    h("div", { class: "actions" }, preview),
    h("details", { class: "subsection" }, h("summary", { text: "Failure e-mail (optional)" }),
      field("Failure subject", f.fsub), h("label", { class: "field" }, "Failure body", placeholderBar(f.fbody), f.fbody)));
  notifyBody.append(h("div", { class: "grid-2" }, field("Send the report e-mail when the run succeeds", f.nsucc),
                                             field("Send a failure e-mail when the run fails", f.nfail)), notifyHint);
  syncEmail();
  mainArea().replaceChildren(form);
  save.disabled = true;                            // until the employee list has loaded (re-enabled by onLoaded, success or failure)
  picker.start();
}

// Template identity = its Description (falls back to the stored name for older templates).
const tplName = (x) => (x && (x.description || x.name)) || "";
// The configuration a task copies from a template; the report name used in SAP files/placeholders is the Description.
const tplConfig = (tp) => ({ ...(tp.config || {}), report_name: tplName(tp) });
// Read-only view of a report configuration incl. the resolved reporting period.
function configSummary(c, source) {
  const rows = [["T-Code", c.tcode || "—"], ["Variant", c.variant || "—"], ["Date fields", (c.date_fields || []).join(", ") || "— (variant dates used)"],
                ["Date rule", RULE_LABELS[c.date_rule] || c.date_rule || "—"], ["Reporting period", periodText(c.date_rule, c.custom_from, c.custom_to)],
                ["Workbook name", (c.output || {}).filename_pattern || "{ReportName}_{Period}"]];
  return h("div", { class: "fieldset" }, h("div", { class: "hint", text: `SAP report configuration - ${source}` }),
    h("dl", { class: "dl" }, rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])));
}

async function runNow(t) {
  let live = false;
  if (t.execution_target === "live_sap") {
    if (!confirm(`LIVE SAP Run Now for "${t.name}".\n\nThe assigned employee's runner must be running with --allow-live --attended and the person must be present for the SAP login.\n\nStart the live run now?`)) return;
    live = true;
  } else if (!confirm(`Run "${t.name}" now?`)) return;
  try {
    const rows = await api("/rpc/admin_run_now", { method: "POST", body: JSON.stringify({ p_task: t.id, p_request_key: uid(), p_confirm_live: live }) });
    alert(`Queued ${rows.length} run(s). Track them under "Task status".`);
    tab = "admin_runs"; render();
  } catch (x) { alert(`Run Now refused: ${x.message}`); }
}

// ------------------------------------------------------------------ runs: failures + cancel
async function adminRuns() {
  const rows = await api("/occurrences?select=id,kind,status,due_at,attempts,max_attempts,employee_id,tasks(name,description),profiles!occurrences_employee_id_fkey(full_name),executions(attempt_no,status,finished_at,row_count,validation_status,error_class,error_detail,engine)&order=due_at.desc&limit=150");
  return table([["Task", (o) => repName(o.tasks)], ["Employee", (o) => (o.profiles || {}).full_name || "—"],
                ["Due", (o) => fmt(o.due_at)], ["Status", (o) => badge(o.status)],
                ["Last attempt", (o) => { const e = (o.executions || []).sort((a, b) => b.attempt_no - a.attempt_no)[0];
                   return e ? h("div", {}, badge(e.status), ` ${e.engine || ""} ${e.row_count != null ? e.row_count + " rows" : ""}`,
                     e.error_class ? h("div", { class: "muted", text: `${e.error_class}${e.error_detail ? " - " + e.error_detail : ""}` }) : null) : "not started"; }],
                ["", (o) => ["pending", "waiting_retry", "claimed"].includes(o.status)
                   ? h("button", { class: "secondary", text: "Cancel", onclick: async () => {
                       const reason = prompt("Reason for cancelling (3-200 characters):");
                       if (!reason) return;
                       try { await api("/rpc/admin_cancel_occurrence", { method: "POST", body: JSON.stringify({ p_occurrence: o.id, p_reason: reason }) }); render(); }
                       catch (x) { alert(x.message); } } }) : ""]], rows, "No runs yet.");
}

// ------------------------------------------------------------------ portal invitation (separate from PC registration)
// E-mails a fresh one-time password-setup link to the account's REGISTERED address (admin-setup-link, deliver=email).
// The link itself never reaches this page. The button stays disabled while sending and for 2 minutes after a send;
// the server refuses repeats within 2 minutes as well. Existing accounts only - nothing is created.
const inviteCooldown = new Map();                       // user_id -> time the last invitation was sent
function inviteControl(p) {
  const status = h("div", { class: "hint" });
  const cooling = () => Date.now() - (inviteCooldown.get(p.id) || 0) < 120000;
  const btn = h("button", { class: "secondary small", text: "Invite / Resend setup link", disabled: p.status !== "active" || cooling(),
    onclick: async () => {
      if (!confirm(`Send a password-setup e-mail to ${p.full_name} (${p.email})?\n\nAny earlier setup link for this account stops working.`)) return;
      btn.disabled = true; status.className = "hint"; status.textContent = "Sending…";
      try {
        const r = await fetch(`${FN}/admin-setup-link`, { method: "POST",
          headers: { apikey: KEY, authorization: `Bearer ${await token()}`, "content-type": "application/json" },
          body: JSON.stringify({ user_id: p.id, kind: "setup", deliver: "email" }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message || `Request failed (${r.status})`);
        inviteCooldown.set(p.id, Date.now());
        status.className = "hint ok-text"; status.textContent = `Setup e-mail sent to ${j.email || p.email}.`;
        setTimeout(() => { btn.disabled = cooling(); }, 120000);
      } catch (x) {
        status.className = "error"; status.textContent = `Not sent: ${x.message}`;
        btn.disabled = false;
      }
    } });
  if (cooling()) status.textContent = "Setup e-mail sent recently.";
  return h("div", {}, btn, status);
}

// ------------------------------------------------------------------ people, SAP identities, runners
async function adminPeople() {
  const [people, ids, runners, conn] = await Promise.all([
    api("/profiles?select=id,full_name,email,employee_code,role,status&order=full_name"),
    api("/sap_identities?select=employee_id,sap_user_id,status,credential_configured,last_result"),
    api("/runners?select=id,employee_id,name,status,last_seen_at,live_permitted,version&order=registered_at.desc"),
    api("/app_connections?select=id&code=eq.sap_prd")]);
  const online = (r) => r.last_seen_at && Date.now() - new Date(r.last_seen_at).getTime() < 10 * 60000;
  return table([["Person", (p) => h("div", {}, h("strong", { text: p.full_name }), h("div", { class: "muted", text: `${p.email} · ${p.employee_code} · ${p.role}` }))],
                ["Account", (p) => badge(p.status)],
                ["Portal access", (p) => p.id === me.user_id ? h("span", { class: "muted", text: "you" }) : inviteControl(p)],
                ["SAP user", (p) => { const i = ids.find((x) => x.employee_id === p.id);
                   return h("div", {}, i ? `${i.sap_user_id} ` : "—", i ? badge(i.credential_configured ? "password on PC" : "no password on PC") : null,
                     h("button", { class: "link", text: "change", onclick: async () => {
                       const v = prompt(`SAP user ID for ${p.full_name} (ID only - the password stays on their PC):`, i ? i.sap_user_id : "");
                       if (!v) return;
                       try { await upsert("sap_identities", { employee_id: p.id, connection_id: conn[0].id, sap_user_id: v.trim().toUpperCase(),
                                                               status: "active", updated_by: me.user_id }, "employee_id,connection_id"); render(); }
                       catch (x) { alert(x.message); } } })); }],
                ["Runner", (p) => { const r = runners.find((x) => x.employee_id === p.id && x.status === "active");
                   return r ? h("div", {}, `${r.name} `, badge(online(r) ? (r.live_permitted ? "online · live allowed" : "online") : "offline"),
                       h("div", { class: "muted", text: `last seen ${fmt(r.last_seen_at)}` }),
                       h("button", { class: "link", text: "revoke", onclick: async () => {
                         const reason = prompt(`Revoke runner ${r.name}? Reason:`); if (!reason) return;
                         try { await api("/rpc/admin_revoke_runner", { method: "POST", body: JSON.stringify({ p_runner: r.id, p_reason: reason }) }); render(); }
                         catch (x) { alert(x.message); } } }))
                     : h("button", { class: "secondary", text: "Registration code", disabled: p.status !== "active", onclick: async () => {
                         try { const code = await api("/rpc/admin_issue_runner_code", { method: "POST", body: JSON.stringify({ p_employee: p.id, p_valid_minutes: 60 }) });
                               prompt(`One-time code for ${p.full_name} (valid 60 min). On their PC run:\npython -m bah_runner.agent cloud-register --code <code> --email ${p.email}`, code); }
                         catch (x) { alert(x.message); } } }); }]], people, "No accounts.");
}

// ------------------------------------------------------------------ settings (live SAP switch; e-mail status)
async function adminSettings() {
  const rows = await api("/settings?select=key,value,updated_at");
  const get = (k) => (rows.find((r) => r.key === k) || {}).value || {};
  const liveOn = get("live_sap").manual_enabled === true;
  const mailOn = get("email_delivery").enabled === true;
  return [h("div", { class: "card" }, h("h2", { text: "Live SAP" }),
    h("p", {}, "Manual live SAP Run Now is ", badge(liveOn ? "authorised" : "not authorised"),
      ". Scheduled live SAP runs are impossible by design."),
    h("button", { text: liveOn ? "Withdraw live SAP authorisation" : "Authorise manual live SAP Run Now", onclick: async () => {
      if (!confirm(liveOn ? "Withdraw authorisation for live SAP runs?" : "Authorise MANUAL, ATTENDED live SAP Run Now (each run still needs your confirmation)?")) return;
      try { await upsert("settings", { key: "live_sap", value: { manual_enabled: !liveOn }, updated_by: me.user_id }, "key"); render(); }
      catch (x) { alert(x.message); } } })),
    h("div", { class: "card" }, h("h2", { text: "Cloud e-mail" }),
    h("p", {}, "Cloud e-mail sending is ", badge(mailOn ? "enabled" : "not enabled"),
      `. SMTP: ${get("smtp").host || "—"}:${get("smtp").port || ""} as ${get("smtp").username || "—"} (password held only as a server secret). ` +
      "E-mails are queued for every finished run with e-mail on (including report runs handed over by the local BAH); while sending is enabled the central sender delivers them every minute."),
    h("div", { class: "actions" },
      h("button", { class: "secondary", text: "Test SMTP connection (sends nothing)", onclick: async (e) => {
        e.target.disabled = true;
        try { const r = await mailCall("test"); alert(`${r.ok ? "OK" : "Failed"}: ${r.message}`); }
        catch (x) { alert(x.message); } finally { e.target.disabled = false; } } }),
      h("button", { text: mailOn ? "Disable cloud e-mail sending" : "Enable cloud e-mail sending", onclick: async () => {
        if (!confirm(mailOn ? "Stop cloud e-mail sending? Queued e-mails wait until it is enabled again."
                            : "Enable cloud e-mail sending? Queued report e-mails will be sent to their real recipients within a minute.")) return;
        try { await upsert("settings", { key: "email_delivery", value: { enabled: !mailOn }, updated_by: me.user_id }, "key"); render(); }
        catch (x) { alert(x.message); } } }),
      mailOn ? h("button", { class: "secondary", text: "Send queued e-mails now", onclick: async (e) => {
        e.target.disabled = true;
        try { const r = await mailCall("send-now"); alert(r.reason ? r.reason : `Processed ${r.processed} e-mail(s).`); render(); }
        catch (x) { alert(x.message); } finally { e.target.disabled = false; } } }) : null))];
}

async function mailCall(action) {
  const r = await fetch(`${FN}/mail-sender/${action}`, { method: "POST", body: "{}",
    headers: { apikey: KEY, authorization: `Bearer ${await token()}`, "content-type": "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Request failed (${r.status})`);
  return j;
}

// ------------------------------------------------------------------ report templates
async function adminTemplates() {
  const rows = await api("/report_templates?select=id,name,description,version,status,config&order=name");
  rows.sort((a, b) => tplName(a).localeCompare(tplName(b)));
  return { actions: [h("button", { class: "primary", text: "New template", onclick: () => editTemplate(null) })],
    content: table([["Description", (t) => h("strong", { text: tplName(t) })],
              ["Source", () => "SAP Fiori"], ["T-Code", (t) => t.config.tcode || "—"], ["Variant", (t) => t.config.variant || "—"],
              ["Date rule", (t) => RULE_LABELS[t.config.date_rule] || t.config.date_rule || "—"],
              ["Reporting period (today)", (t) => periodText(t.config.date_rule, t.config.custom_from, t.config.custom_to)],
              ["Version", (t) => String(t.version)], ["Status", (t) => badge(t.status)],
              ["", (t) => h("div", { class: "actions" }, h("button", { class: "small", text: "Edit", onclick: () => editTemplate(t) }))]],
             rows, "No templates yet - create the first one.") };
}

function editTemplate(t) {
  const c = (t && t.config) || { date_rule: "previous_month", output: {} };
  const f = { desc: inp(tplName(t), { maxlength: "120", required: true }),
    tcode: inp(c.tcode, { required: true, maxlength: "40" }), variant: inp(c.variant),
    dates: inp((c.date_fields || []).join(", ")), rule: sel(c.date_rule, DATE_RULES.map((r) => [r, RULE_LABELS[r] || r])),
    from: inp(c.custom_from, { type: "date" }), to: inp(c.custom_to, { type: "date" }),
    pattern: inp((c.output || {}).filename_pattern || "{ReportName}_{Period}"),
    status: sel(t ? t.status : "active", [["active", "Active"], ["inactive", "Inactive"]]) };
  // read-only reporting period, recalculated whenever the date rule or the custom dates change
  const period = h("input", { readonly: true, tabindex: "-1" });
  const fromField = field("Custom from", f.from), toField = field("Custom to", f.to);
  const refresh = () => {
    const custom = f.rule.value === "custom";
    fromField.style.display = toField.style.display = custom ? "" : "none";
    period.value = periodText(f.rule.value, f.from.value, f.to.value);
  };
  for (const el of [f.rule, f.from, f.to]) { el.addEventListener("change", refresh); el.addEventListener("input", refresh); }
  const err = h("div", { class: "err" });
  mainArea().replaceChildren(h("form", { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    try {
      const desc = f.desc.value.trim();
      if (!desc) throw new Error("Description is required.");
      if (f.rule.value === "custom" && (!f.from.value || !f.to.value)) throw new Error("Custom date rule needs From and To dates.");
      if (f.rule.value === "custom" && f.from.value > f.to.value) throw new Error("Custom From must not be after To.");
      const config = { ...c, tcode: f.tcode.value.trim().toUpperCase(), report_name: desc,
        variant: f.variant.value.trim() || null, date_fields: f.dates.value.split(",").map((x) => x.trim()).filter(Boolean),
        date_rule: f.rule.value, custom_from: f.rule.value === "custom" ? f.from.value : null,
        custom_to: f.rule.value === "custom" ? f.to.value : null, output: { ...(c.output || {}), filename_pattern: f.pattern.value.trim() } };
      // Description is the single report identifier (also stored as the template's internal name).
      const row = { name: desc, description: desc, connector: "sap_fiori", config, status: f.status.value };
      if (t) await api(`/report_templates?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ ...row, version: t.version + 1 }) });
      else await api("/report_templates", { method: "POST", body: JSON.stringify({ ...row, created_by: me.user_id }) });
      tab = "admin_templates"; render();
    } catch (x) { err.textContent = /duplicate|unique/i.test(x.message) ? "Another template already uses this description." : x.message; }
  } }, pageHead(t ? `Edit template - version ${t.version}` : "New report template",
      "Reusable report definitions. Editing creates a new version; existing tasks keep their copy.",
      h("button", { class: "primary", text: t ? "Save new version" : "Create template" }),
      h("button", { type: "button", class: "secondary", text: "Cancel", onclick: () => render() })),
    h("div", { class: "card" }, h("div", { class: "grid" }, field("Description", f.desc, "The report's name everywhere: task lists, history, e-mail subjects and workbook names."),
      field("T-Code", f.tcode), field("Variant", f.variant, "Layout and selections come from the SAP variant."),
      field("Date fields (comma-separated)", f.dates), field("Date rule", f.rule), field("Reporting period", period, "Resolved for today (Asia/Karachi); exactly the dates entered in SAP."),
      fromField, toField, field("Workbook name pattern", f.pattern, "{ReportName} = Description, {Period} = reporting period."), field("Status", f.status)),
    h("p", { class: "hint", text: "Editing a template does not change existing tasks: each task keeps the configuration it was saved with." })), err));
  refresh();
}

// ------------------------------------------------------------------ runner releases (admin only)
const SHA_RE = /^[0-9a-f]{64}$/;
async function sha256Hex(buf) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function adminReleases() {
  const [rels, runners, people] = await Promise.all([
    api("/runner_releases?select=*&order=created_at.desc"),
    api("/runners?select=id,employee_id,name,version,last_seen_at,status&status=eq.active"),
    api("/profiles?select=id,full_name,email")]);
  const stable = rels.filter((r) => r.status === "stable").sort((a, b) => vcmp(b.version, a.version))[0] || null;
  const who = (id) => (people.find((p) => p.id === id) || {}).full_name || "?";
  const setStatus = async (r, status) => {
    let sha = null;
    if (status === "testing" || status === "stable") {
      sha = (prompt(`Mark ${r.version} as ${status.toUpperCase()}.\n\nPaste the SHA-256 printed by the build script for BAH-Runner-${r.version}.zip:`) || "").trim().toLowerCase();
      if (!sha) return;
    } else if (!confirm(status === "retired" ? `Retire ${r.version}? It can no longer be downloaded by employees (this is final).`
                                             : `Move ${r.version} back to ${status}?`)) return;
    try { await api("/rpc/admin_set_release_status", { method: "POST", body: JSON.stringify({ p_release: r.id, p_status: status, p_expected_sha256: sha }) }); render(); }
    catch (x) { alert(x.message); }
  };
  const actions = (r) => h("div", { class: "actions" },
    h("button", { class: "small", text: "Download", onclick: (e) => releaseDownload(r.object_path, e.target) }),
    r.status === "draft" ? h("button", { class: "small", text: "Mark Testing", onclick: () => setStatus(r, "testing") }) : null,
    r.status === "testing" ? h("button", { class: "small", text: "Mark Stable", onclick: () => setStatus(r, "stable") }) : null,
    r.status === "testing" ? h("button", { class: "small", text: "Back to Draft", onclick: () => setStatus(r, "draft") }) : null,
    r.status !== "retired" ? h("button", { class: "small danger", text: "Retire", onclick: () => setStatus(r, "retired") }) : null);
  const relBadge = (s) => h("span", { class: `badge ${{ stable: "ok", testing: "info", draft: "warn", retired: "" }[s] || ""}`, text: s });
  return { actions: [h("button", { class: "primary", text: "Upload new release", onclick: () => uploadRelease() })], content: [
    h("div", { class: "notice", text: stable ? `Employees are offered ${stable.version} (latest Stable). Only Stable releases can be downloaded by employees.`
                                             : "No Stable release yet - employees cannot download the runner." }),
    h("div", { class: "card" }, h("h2", { text: "Releases" }),
      ...table([["Version", (r) => h("strong", { text: r.version })], ["Status", (r) => relBadge(r.status)],
                ["Release date", (r) => r.release_date], ["Size", (r) => `${Math.max(1, Math.round(r.size_bytes / 1024))} KB`],
                ["SHA-256", (r) => h("span", { class: "mono", title: r.sha256, text: r.sha256.slice(0, 16) + "…" })],
                ["Checksum confirmed", (r) => r.checksum_verified_at ? fmt(r.checksum_verified_at) : "—"],
                ["Min. supported", (r) => r.min_supported_version || "—"],
                ["Notes", (r) => h("div", { class: "muted prewrap notes-cell", text: r.notes || "—" })],
                ["", actions]], rels, "No releases uploaded yet.")),
    h("div", { class: "card" }, h("h2", { text: "Installed runner versions" }),
      ...table([["Employee", (r) => who(r.employee_id)], ["Runner", (r) => r.name],
                ["Version", (r) => String(r.version || "—").replace(/^cloud-/, "")],
                ["Status", (r) => { const [t, c] = runnerState(r.version, stable); return h("span", { class: `badge ${c}`, text: t }); }],
                ["Last seen", (r) => fmt(r.last_seen_at)]], runners, "No active runners."))] };
}

function uploadRelease() {
  const f = { version: inp("", { placeholder: "1.0.1", required: true, pattern: "\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}" }),
    date: inp(new Date().toISOString().slice(0, 10), { type: "date", required: true }),
    min: inp("", { placeholder: "optional, e.g. 1.0.0" }), notes: h("textarea", { rows: "6", maxlength: "4000" }),
    file: h("input", { type: "file", accept: ".zip", required: true }) };
  const err = h("div", { class: "err" }), info = h("div", { class: "hint" });
  const save = h("button", { class: "primary", text: "Upload as Draft" });
  mainArea().replaceChildren(h("form", { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; save.disabled = true;
    try {
      const version = f.version.value.trim(), file = f.file.files[0];
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)) throw new Error("Version must be MAJOR.MINOR.PATCH, e.g. 1.0.1");
      if (f.min.value.trim() && !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(f.min.value.trim())) throw new Error("Minimum supported version must be MAJOR.MINOR.PATCH");
      if (!file || file.name !== `BAH-Runner-${version}.zip`) throw new Error(`Choose the package file BAH-Runner-${version}.zip built by the build script.`);
      if (file.size > 52428800) throw new Error("Package larger than 50 MB.");
      const buf = await file.arrayBuffer(), sha = await sha256Hex(buf);
      info.textContent = `SHA-256 of the selected file: ${sha}`;
      const path = `releases/${version}/${file.name}`;
      const up = await fetch(`${PROJECT}/storage/v1/object/${RELEASE_BUCKET}/${path}`, { method: "POST", body: buf,
        headers: { apikey: KEY, authorization: `Bearer ${await token()}`, "content-type": "application/zip", "x-upsert": "false" } });
      if (!up.ok) throw new Error(`Upload refused (${up.status}) - a package for this version may already exist.`);
      await api("/runner_releases", { method: "POST", body: JSON.stringify({ version, file_name: file.name, object_path: path,
        size_bytes: file.size, sha256: sha, release_date: f.date.value, notes: f.notes.value.trim(),
        min_supported_version: f.min.value.trim() || null, created_by: me.user_id }) });
      tab = "admin_releases"; render();
    } catch (x) { err.textContent = x.message; } finally { save.disabled = false; }
  } }, pageHead("Upload a new runner release", "The generic package (one for all employees). It starts as Draft; confirm its checksum to move it to Testing and Stable.",
       save, h("button", { type: "button", class: "secondary", text: "Cancel", onclick: () => render() })),
    h("div", { class: "card" }, h("div", { class: "grid" }, field("Version", f.version, "Must match bah_runner/VERSION in the package"),
      field("Release date", f.date), field("Minimum supported version", f.min, "Older runners are told to update now"),
      field("Package file", f.file, "dist\\BAH-Runner-<version>.zip from Build-RunnerPackage.ps1")),
      field("What's new / release notes", f.notes), info), err));
}

// Same sections and labels as the local BAH admin navigation.
const ADMIN_TABS = ["Overview", ["admin_dashboard", "Dashboard", "Operational overview - cloud BAH."],
  "Automation", ["admin_templates", "Report Templates", "Reusable report definitions. Editing creates a new version; existing tasks keep their copy."],
  ["admin_tasks", "Tasks", "Report tasks, schedules and employee assignments."],
  "People & execution", ["admin_people", "Employees", "Accounts, SAP user IDs and each employee's runner."],
  ["runner", "BAH Runner", "Download, install and update the BAH Runner on your PC."],
  "Monitoring", ["admin_runs", "Execution History", "Every run, including report runs handed over by the local BAH."],
  ["reports", "Reports", "Validated workbooks stored in the cloud."], ["notifications", "E-mail Notifications", "Report e-mails sent by the cloud BAH."],
  "System", ["admin_releases", "Runner Releases", "Generic BAH Runner packages: upload, verify, release, retire; installed versions."],
  ["admin_settings", "Settings", "Live SAP authorisation and cloud e-mail sending."]];
const ADMIN_VIEWS = { admin_dashboard: adminDashboard, admin_tasks: adminTasks, admin_templates: adminTemplates, admin_people: adminPeople,
                      admin_settings: adminSettings, admin_runs: adminRuns, admin_releases: adminReleases };
