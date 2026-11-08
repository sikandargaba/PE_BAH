// PE BAH - administrator screens (loaded for everyone, shown only when the database says is_admin).
// Every write goes through the REST API with the admin's own session: row-level security and the bah.admin_*
// functions decide (inactive or non-admin users are refused by the database, not by this page).
"use strict";

const DATE_RULES = ["today", "previous_day", "current_month", "previous_month", "current_week", "previous_week",
                    "rolling_7_days", "rolling_30_days", "rolling_90_days", "custom"];
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const list = (s) => String(s || "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, "").slice(0, 32);

function field(label, input, hint) {
  return h("div", { class: "field" }, h("label", { text: label }), input, hint ? h("div", { class: "muted", text: hint }) : null);
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
    api("/tasks?select=id,name,description,execution_target,execution_mode,status,schedules(frequency,run_time,weekday,month_day,last_day_of_month,anchor_date,status),assignments(id,employee_id,status)&order=name"),
    api("/profiles?select=id,full_name,email,role,status&order=full_name")]);
  const name = (id) => (people.find((p) => p.id === id) || {}).full_name || "?";
  return [h("p", {}, h("button", { text: "New task", onclick: () => editTask(null, people) })),
    ...table([["Task", (t) => h("div", {}, h("strong", { text: t.name }), t.description ? h("div", { class: "muted", text: t.description }) : null)],
              ["Runs on", (t) => t.execution_target === "live_sap" ? "Live SAP (attended)" : t.execution_target],
              ["Schedule", (t) => schedText((t.schedules || [])[0])],
              ["Assigned to", (t) => (t.assignments || []).filter((a) => a.status === "active").map((a) => name(a.employee_id)).join(", ") || "—"],
              ["Status", (t) => badge(t.status)],
              ["", (t) => h("div", { class: "actions" },
                 h("button", { class: "secondary", text: "Edit", onclick: () => editTask(t.id, people) }),
                 h("button", { text: "Run Now", disabled: t.status !== "active" || t.execution_mode === "scheduled_only",
                               onclick: () => runNow(t) }))]],
             tasks, "No tasks yet - create the first one.")];
}

async function editTask(id, people) {
  const conn = (await api("/app_connections?select=id,code,display_name&status=eq.active"))[0];
  if (!conn) { alert("No active SAP connection configured."); return; }
  let t = { name: "", description: "", execution_target: "live_sap", execution_mode: "manual_only", status: "active" };
  let cfg = { tcode: "", report_name: "", variant: "", date_fields: [], date_rule: "previous_month", output: {} };
  let em = { enabled: false, to: [], cc: [], bcc: [], subject: "", body: "", failure_subject: "", failure_body: "",
             notify_success: true, notify_failure: false, delivery_format: "attachment" };
  let sc = null, asg = [];
  if (id) {
    t = (await api(`/tasks?select=*&id=eq.${id}`))[0];
    const c = (await api(`/task_configs?select=config,email&task_id=eq.${id}`))[0];
    if (c) { cfg = { ...cfg, ...c.config }; em = { ...em, ...c.email }; }
    sc = (await api(`/schedules?select=*&task_id=eq.${id}`))[0] || null;
    asg = await api(`/assignments?select=id,employee_id,status&task_id=eq.${id}`);
  }
  const f = {
    name: inp(t.name, { maxlength: "120", required: true }), description: inp(t.description, { maxlength: "200" }),
    target: sel(t.execution_target, [["live_sap", "Live SAP (manual, attended)"], ["synthetic", "Synthetic (test)"], ["fixture", "Fixture (test)"]]),
    mode: sel(t.execution_mode, [["manual_only", "Manual Run Now only"], ["scheduled_and_manual", "Scheduled and manual"], ["scheduled_only", "Scheduled only"]]),
    status: sel(t.status, [["active", "Active"], ["paused", "Paused"], ["inactive", "Inactive"]]),
    tcode: inp(cfg.tcode, { maxlength: "40", required: true }), report: inp(cfg.report_name, { maxlength: "80" }),
    variant: inp(cfg.variant, { maxlength: "40" }), dates: inp((cfg.date_fields || []).join(", ")),
    rule: sel(cfg.date_rule, DATE_RULES.map((r) => [r, r.replaceAll("_", " ")])),
    from: inp(cfg.custom_from, { type: "date" }), to: inp(cfg.custom_to, { type: "date" }),
    pattern: inp((cfg.output || {}).filename_pattern || "{ReportName}_{Period}"),
    freq: sel(sc ? sc.frequency : "", [["", "No schedule"], ["daily", "Daily"], ["weekly", "Weekly"], ["fortnightly", "Fortnightly"], ["monthly", "Monthly"]]),
    time: inp(sc ? sc.run_time.slice(0, 5) : "08:00", { type: "time" }),
    weekday: sel(sc && sc.weekday ? String(sc.weekday) : "1", [["1", "Monday"], ["2", "Tuesday"], ["3", "Wednesday"], ["4", "Thursday"], ["5", "Friday"], ["6", "Saturday"], ["7", "Sunday"]]),
    anchor: inp(sc ? sc.anchor_date : "", { type: "date" }), mday: inp(sc && sc.month_day ? sc.month_day : 1, { type: "number", min: "1", max: "31" }),
    lastday: chk(sc && sc.last_day_of_month),
    eon: chk(em.enabled), eto: inp((em.to || []).join(", ")), ecc: inp((em.cc || []).join(", ")), ebcc: inp((em.bcc || []).join(", ")),
    esub: inp(em.subject, { maxlength: "200" }), ebody: h("textarea", { rows: "4" }), fsub: inp(em.failure_subject, { maxlength: "200" }),
    fbody: h("textarea", { rows: "3" }), nsucc: chk(em.notify_success), nfail: chk(em.notify_failure),
    efmt: sel(em.delivery_format, [["attachment", "Excel attachment only"], ["body", "Data in e-mail body only"], ["both", "Both"]]),
  };
  f.ebody.value = em.body || ""; f.fbody.value = em.failure_body || "";
  const assignBoxes = people.filter((p) => p.status === "active").map((p) => {
    const a = asg.find((x) => x.employee_id === p.id);
    return { p, a, box: chk(a && a.status === "active") };
  });
  const err = h("div", { class: "err" });
  const save = h("button", { text: id ? "Save changes" : "Create task" });
  const form = h("form", { class: "card", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; save.disabled = true;
    try {
      const rcpt = { to: list(f.eto.value), cc: list(f.ecc.value), bcc: list(f.ebcc.value) };
      const bad = [...rcpt.to, ...rcpt.cc, ...rcpt.bcc].filter((a) => !EMAIL_RE.test(a));
      if (bad.length) throw new Error(`Invalid e-mail address: ${bad.join(", ")}`);
      if (f.eon.checked && !rcpt.to.length) throw new Error("E-mail is enabled - add at least one 'To' recipient.");
      if (f.rule.value === "custom" && (!f.from.value || !f.to.value)) throw new Error("Custom date rule needs From and To dates.");
      const row = { name: f.name.value.trim(), description: f.description.value.trim() || null, connection_id: conn.id,
                    execution_target: f.target.value, execution_mode: f.mode.value, status: f.status.value };
      const saved = id ? (await api(`/tasks?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(row), headers: { prefer: "return=representation" } }))[0]
                       : (await api("/tasks", { method: "POST", body: JSON.stringify({ ...row, created_by: me.user_id }), headers: { prefer: "return=representation" } }))[0];
      const tid = saved.id;
      const config = { tcode: f.tcode.value.trim().toUpperCase(), report_name: f.report.value.trim() || f.tcode.value.trim().toUpperCase(),
                       variant: f.variant.value.trim() || null, date_fields: list(f.dates.value).length ? f.dates.value.split(",").map((x) => x.trim()).filter(Boolean) : [],
                       date_rule: f.rule.value, custom_from: f.rule.value === "custom" ? f.from.value : null,
                       custom_to: f.rule.value === "custom" ? f.to.value : null, output: { ...(cfg.output || {}), filename_pattern: f.pattern.value.trim() } };
      const email = { enabled: f.eon.checked, ...rcpt, subject: f.esub.value.trim(), body: f.ebody.value, failure_subject: f.fsub.value.trim(),
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
    h("h2", { text: id ? `Edit task: ${t.name}` : "New task" }),
    h("div", { class: "grid" }, field("Task name", f.name), field("Description (shown in e-mails)", f.description),
      field("Runs on", f.target, "Live SAP runs only by Run Now, attended, on the assigned employee's own runner."),
      field("Execution mode", f.mode), field("Status", f.status)),
    h("h3", { text: "SAP report" }),
    h("div", { class: "grid" }, field("T-Code", f.tcode), field("Report name", f.report),
      field("Variant", f.variant, "Plant, movement types and LAYOUT come from the SAP variant (BAH never changes them)."),
      field("Date fields (comma-separated selection labels)", f.dates), field("Date rule", f.rule),
      field("Custom from", f.from), field("Custom to", f.to), field("Workbook name pattern", f.pattern, "{ReportName} and {Period} are replaced.")),
    h("h3", { text: "Schedule" }),
    h("div", { class: "grid" }, field("Frequency", f.freq, "Scheduled live SAP runs are disabled; schedules apply to test tasks."),
      field("Time (Asia/Karachi)", f.time), field("Weekday (weekly)", f.weekday), field("Anchor date (fortnightly)", f.anchor),
      field("Day of month (monthly)", f.mday), field("Last day of month (monthly)", f.lastday)),
    h("h3", { text: "Assigned employees" }),
    h("div", { class: "grid" }, assignBoxes.map(({ p, box }) => h("label", { class: "inline" }, box, ` ${p.full_name} (${p.role})`))),
    h("h3", { text: "E-mail" }),
    h("div", { class: "grid" }, field("Send e-mail", f.eon), field("Delivery format", f.efmt), field("To", f.eto), field("CC", f.ecc), field("BCC", f.ebcc),
      field("Subject", f.esub, "Placeholders: {report_name} {period_start} {period_end} {execution_date} {assigned_employee} {execution_status}"),
      field("Body (blank = standard text)", f.ebody), field("Notify on success", f.nsucc), field("Notify on failure", f.nfail),
      field("Failure subject", f.fsub), field("Failure body", f.fbody)),
    h("p", { class: "actions" }, save, h("button", { type: "button", class: "secondary", text: "Cancel", onclick: () => render() })), err);
  app.replaceChildren(form);
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
  const rows = await api("/occurrences?select=id,kind,status,due_at,attempts,max_attempts,employee_id,tasks(name),profiles!occurrences_employee_id_fkey(full_name),executions(attempt_no,status,finished_at,row_count,validation_status,error_class,error_detail,engine)&order=due_at.desc&limit=150");
  return table([["Task", (o) => (o.tasks || {}).name || "—"], ["Employee", (o) => (o.profiles || {}).full_name || "—"],
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
  return [h("h3", { text: "Live SAP" }),
    h("p", {}, "Manual live SAP Run Now is ", badge(liveOn ? "authorised" : "not authorised"),
      ". Scheduled live SAP runs are impossible by design."),
    h("button", { text: liveOn ? "Withdraw live SAP authorisation" : "Authorise manual live SAP Run Now", onclick: async () => {
      if (!confirm(liveOn ? "Withdraw authorisation for live SAP runs?" : "Authorise MANUAL, ATTENDED live SAP Run Now (each run still needs your confirmation)?")) return;
      try { await upsert("settings", { key: "live_sap", value: { manual_enabled: !liveOn }, updated_by: me.user_id }, "key"); render(); }
      catch (x) { alert(x.message); } } }),
    h("h3", { text: "Cloud e-mail" }),
    h("p", {}, "Cloud e-mail sending is ", badge(mailOn ? "enabled" : "not enabled"),
      ". E-mails are queued for every finished run; the central cloud sender delivers them once it is approved and enabled. The local BAH keeps sending its own e-mails as before.")];
}

const ADMIN_TABS = [["admin_tasks", "Tasks"], ["admin_runs", "Task status"], ["admin_people", "People & runners"], ["reports", "Reports"],
                    ["notifications", "Notifications"], ["admin_settings", "Settings"]];
const ADMIN_VIEWS = { admin_tasks: adminTasks, admin_people: adminPeople, admin_settings: adminSettings, admin_runs: adminRuns };
