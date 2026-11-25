// BAH portal - administrator pages for people onboarding and operations: Invitations, SAP Credentials (status only),
// VM Management, Runner Monitoring, System Jobs, Audit Logs, and the Employees page (invite, registration, status).
// Every action is authorised by the database / Edge Functions (bah.is_admin()); hiding a menu item is never the control.
// Loaded after account.js and before app.js; uses app.js helpers at call time only. No SAP password, sealed credential,
// runner token or job command is ever requested or shown here.
"use strict";

const NOT_YET = "Available once the shared-runner database update is applied.";
const notYet = () => [h("div", { class: "notice", text: NOT_YET })];
const fnPost = async (name, body) => {
  const r = await fetch(`${FN}/${name}`, { method: "POST",
    headers: { apikey: KEY, authorization: `Bearer ${await token()}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 207) throw new Error(j.message || j.error || `Request failed (${r.status})`);
  return j;
};
const isOnline = (t) => !!t && Date.now() - new Date(t).getTime() < 10 * 60000;
const ago = (t) => { if (!t) return "never"; const m = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const INVITE_BADGE = { pending: "pending", accepted: "registered", expired: "expired", revoked: "revoked" };
const kpiBox = (label, value, cls = "") => h("div", { class: `kpi ${cls}` }, h("div", { class: "label", text: label }), h("div", { class: "value", text: String(value) }));

// ------------------------------------------------------------------ Employees (replaces the earlier view)
function inviteEmployeeForm() {
  const name = inp("", { maxlength: "120", required: true, autocomplete: "off" });
  const email = inp("", { type: "email", required: true, autocomplete: "off", placeholder: "first.last@pharmevo.biz" });
  const code = inp("", { maxlength: "32", required: true, autocomplete: "off", placeholder: "employee code" });
  const out = h("div", {});
  const btn = h("button", { class: "primary", text: "Create account and invitation" });
  const card = h("div", { class: "card" }, h("h2", { text: "Invite an employee" }));
  const form = h("form", { class: "own", onsubmit: async (e) => {
    e.preventDefault(); out.replaceChildren();
    const em = email.value.trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@pharmevo\.biz$/.test(em)) { out.append(h("div", { class: "error", text: "Use the official @pharmevo.biz address." })); return; }
    btn.disabled = true;
    try {
      const j = await fnPost("admin-create-user", { email: em, employee_code: code.value.trim(), full_name: name.value.trim() });
      form.reset();
      out.append(h("div", { class: "notice", text: `Account created for ${j.email}. The invitation is valid for 7 days; the employee completes registration at first sign-in.` }));
      if (j.setup_link) {
        const link = h("input", { class: "mono", readonly: true, value: j.setup_link, onfocus: (ev) => ev.target.select() });
        out.append(h("label", { class: "field" }, "One-time setup link - hand it to the employee personally (it is not stored)", link),
          h("div", { class: "actions" }, h("button", { type: "button", class: "secondary", text: "Copy link", onclick: async (ev) => {
            try { await navigator.clipboard.writeText(link.value); ev.target.textContent = "Copied"; } catch { link.select(); } } }),
            h("button", { type: "button", class: "secondary", text: "Done (hide link)", onclick: () => { link.value = ""; out.replaceChildren(); render(); } })),
          h("p", { class: "hint", text: "Lost it? Use Create setup link in the Employees table or New setup link under Invitations (a new link replaces this one)." }));
      } else out.append(h("p", { class: "hint", text: "No link was generated - use New setup link under Invitations." }));
    } catch (x) { out.append(h("div", { class: "error", text: `Not created: ${x.message}` })); }
    finally { btn.disabled = false; }
  } }, field("Full name", name), field("Official e-mail", email), field("Employee code", code), btn,
     h("p", { class: "hint", text: "New accounts are always employees. Register their SAP user ID afterwards in the table below." }));
  card.append(form, out);
  return card;
}

async function adminPeopleV2() {
  const [people, ids, runners, conn, invs, creds] = await Promise.all([
    api("/profiles?select=id,full_name,email,employee_code,role,status,registered_at,terms_version&order=full_name")
      .catch(() => api("/profiles?select=id,full_name,email,employee_code,role,status&order=full_name")),   // before the update
    api("/sap_identities?select=employee_id,sap_user_id,status,credential_configured,last_result"),
    api("/runners?select=id,employee_id,name,status,mode,last_seen_at,live_permitted,version&order=registered_at.desc"),
    api("/app_connections?select=id&code=eq.sap_prd"),
    optionalRpc("admin_invitations", {}, null), optionalRpc("admin_sap_credential_overview", {}, null)]);
  const latestInv = (pid) => (invs || []).find((v) => v.user_id === pid);
  const showForm = h("button", { class: "primary", text: "Invite employee", onclick: () => { formSlot.hidden = !formSlot.hidden; } });
  const formSlot = h("div", { hidden: true }, inviteEmployeeForm());
  const statusBtn = (p) => p.id === me.user_id ? null : h("button", { class: "link", text: p.status === "active" ? "deactivate" : "activate",
    onclick: async () => {
      const to = p.status === "active" ? "inactive" : "active";
      const reason = prompt(`${to === "inactive" ? "Deactivate" : "Activate"} ${p.full_name}? ${to === "inactive" ? "They can no longer sign in or submit jobs." : ""}\nReason (min. 3 characters):`);
      if (!reason) return;
      try { await fnPost("admin-set-status", { user_id: p.id, status: to, reason }); render(); } catch (x) { alert(x.message); }
    } });
  const regCell = (p) => {
    if (invs === null) return "—";                                       // before the update: no registration step
    const v = latestInv(p.id);
    if (p.registered_at || !v || v.status === "accepted") return h("span", { class: "badge ok", text: "registered" });
    return h("div", {}, h("span", { class: `badge ${v.status === "pending" ? "info" : "bad"}`, text: INVITE_BADGE[v.status] || v.status }),
      v.status === "pending" ? h("div", { class: "muted", text: `until ${fmt(v.expires_at)}` }) : null);
  };
  const sapCell = (p) => {
    const i = ids.find((x) => x.employee_id === p.id);
    const c = (creds || []).find((x) => x.employee_id === p.id && x.sap_user_id);
    const pwBadge = c && c.credential_status !== "not_configured" ? credBadge(c.credential_status)
      : i ? badge(i.credential_configured ? "password on PC" : "no password on PC") : null;
    return h("div", {}, i ? `${i.sap_user_id} ` : "—", pwBadge,
      h("button", { class: "link", text: "change", onclick: async () => {
        const v = prompt(`SAP user ID for ${p.full_name} (ID only - never the password):`, i ? i.sap_user_id : "");
        if (!v) return;
        try { await upsert("sap_identities", { employee_id: p.id, connection_id: conn[0].id, sap_user_id: v.trim().toUpperCase(),
                                                status: "active", updated_by: me.user_id }, "employee_id,connection_id"); render(); }
        catch (x) { alert(x.message); } } }));
  };
  const runnerCell = (p) => {
    const r = runners.find((x) => x.employee_id === p.id && x.status === "active");
    if (r) return h("div", {}, `${r.name} `, r.mode === "shared" ? badge("shared") : null, " ",
      badge(isOnline(r.last_seen_at) ? (r.live_permitted ? "online · live allowed" : "online") : "offline"),
      h("div", { class: "muted", text: `last seen ${fmt(r.last_seen_at)}` }),
      h("button", { class: "link", text: "revoke", onclick: async () => {
        const reason = prompt(`Revoke runner ${r.name}? Reason:`); if (!reason) return;
        try { await api("/rpc/admin_revoke_runner", { method: "POST", body: JSON.stringify({ p_runner: r.id, p_reason: reason }) }); render(); }
        catch (x) { alert(x.message); } } }));
    const c = (creds || []).find((x) => x.employee_id === p.id && x.credential_status === "configured");
    if (c) return h("span", { class: "muted", text: "uses the shared runner" });
    return h("button", { class: "secondary", text: "Registration code", disabled: p.status !== "active", onclick: async () => {
      try { const code = await api("/rpc/admin_issue_runner_code", { method: "POST", body: JSON.stringify({ p_employee: p.id, p_valid_minutes: 60 }) });
            prompt(`One-time code for ${p.full_name} (valid 60 min). On their PC run:\npython -m bah_runner.agent cloud-register --code <code> --email ${p.email}`, code); }
      catch (x) { alert(x.message); } } });
  };
  return { actions: [showForm], content: [formSlot, ...table([
    ["Person", (p) => h("div", {}, h("strong", { text: p.full_name }), h("div", { class: "muted", text: `${p.email} · ${p.employee_code} · ${p.role}` }))],
    ["Account", (p) => h("div", {}, badge(p.status), " ", statusBtn(p))],
    ["Registration", regCell],
    ["Portal access", (p) => p.id === me.user_id ? h("span", { class: "muted", text: "you" }) : inviteControl(p)],
    ["SAP user", sapCell],
    ["Runner", runnerCell]], people, "No accounts.")] };
}

// ------------------------------------------------------------------ Invitations
async function adminInvitations() {
  const rows = await optionalRpc("admin_invitations", {}, null);
  if (rows === null) return notYet();
  const n = (s) => rows.filter((v) => v.status === s).length;
  return [
    h("div", { class: "card" }, h("h2", { text: "Invitations" }), h("div", { class: "kpis" },
      kpiBox("Pending", n("pending"), "warn"), kpiBox("Registered", n("accepted"), "ok"), kpiBox("Expired", n("expired"), "bad"), kpiBox("Revoked", n("revoked")))),
    h("div", { class: "notice", text: "Create accounts under Employees → Invite employee. New setup link creates a new one-time link for you to hand over personally (no e-mail is sent) and extends the invitation by 7 days." }),
    ...table([
      ["Person", (v) => h("div", {}, h("strong", { text: v.full_name }), h("div", { class: "muted", text: v.email }))],
      ["Status", (v) => h("span", { class: `badge ${v.status === "accepted" ? "ok" : v.status === "pending" ? "info" : "bad"}`, text: INVITE_BADGE[v.status] || v.status })],
      ["Invited", (v) => h("div", {}, fmt(v.created_at), h("div", { class: "muted", text: v.invited_by ? `by ${v.invited_by}` : "" }))],
      ["Last sent", (v) => h("div", {}, fmt(v.last_sent_at), h("div", { class: "muted", text: `${v.send_count} time(s)` }))],
      ["Expires / closed", (v) => v.status === "accepted" ? `registered ${fmt(v.accepted_at)}` : v.status === "revoked" ? `revoked ${fmt(v.revoked_at)}` : fmt(v.expires_at)],
      ["", (v) => {
        if (v.status === "accepted" || v.status === "revoked") return null;
        const msg = h("div", { class: "hint" });
        const slot = h("div", {});
        // no cloud e-mail: a new one-time link is shown here for the admin to hand over (see setupLinkPanel in admin.js)
        const resend = h("button", { class: "secondary small", text: "New setup link", onclick: async () => {
          if (!confirm(`Create a new one-time setup link for ${v.full_name} (${v.email})?\n\n` +
                       "No e-mail is sent: you hand the link over personally. Any earlier link stops working; the invitation is extended by 7 days.")) return;
          resend.disabled = true; msg.className = "hint"; msg.textContent = "Creating…"; slot.replaceChildren();
          try { const link = await createSetupLink(v.user_id, "setup"); msg.textContent = ""; slot.replaceChildren(setupLinkPanel(link, v.full_name, () => render())); }
          catch (x) { msg.className = "error"; msg.textContent = `No link created: ${x.message}`; }
          finally { resend.disabled = false; }
        } });
        const revoke = v.status === "pending" ? h("button", { class: "secondary small danger", text: "Revoke", onclick: async () => {
          if (!confirm(`Revoke the invitation for ${v.full_name}?\n\nThe account is deactivated, so the link and any password set with it stop working.`)) return;
          try { await rpc("admin_revoke_invitation", { p_invitation: v.id }); render(); } catch (x) { msg.className = "error"; msg.textContent = x.message; }
        } }) : null;
        return h("div", {}, h("div", { class: "actions" }, resend, revoke), msg, slot);
      }]], rows, "No invitations yet.")];
}

// ------------------------------------------------------------------ SAP Credentials (status only)
async function adminCredentials() {
  const rows = await optionalRpc("admin_sap_credential_overview", {}, null);
  if (rows === null) return notYet();
  const n = (s) => rows.filter((r) => r.credential_status === s).length;
  return [
    h("div", { class: "card" }, h("h2", { text: "Saved SAP passwords" }), h("div", { class: "kpis" },
      kpiBox("Saved", n("configured"), "ok"), kpiBox("Re-enter required", n("reenter"), "bad"), kpiBox("Not saved", n("not_configured"), "warn"),
      kpiBox("Last test failed", rows.filter((r) => r.credential_status === "configured" && r.last_test_result && r.last_test_result !== "ok").length, "bad"))),
    h("div", { class: "notice", text: "Status only. Passwords are encrypted in each employee's browser for the shared BAH runner; nobody - including administrators - can read or reset them here. Employees manage their own under My SAP Credentials." }),
    ...table([
      ["Employee", (r) => r.full_name],
      ["Connection", (r) => r.connection || "—"],
      ["SAP user ID", (r) => h("span", { class: "mono", text: r.sap_user_id || "—" })],
      ["SAP user", (r) => badge(r.identity_status || "—")],
      ["Password", (r) => credBadge(r.credential_status)],
      ["Saved", (r) => fmt(r.updated_at)],
      ["Connection test", (r) => r.test_pending ? badge("pending") : h("div", {}, testBadge(r.credential_status === "configured" ? r.last_test_result : null),
        r.credential_status === "configured" && r.last_test_at ? h("div", { class: "muted", text: fmt(r.last_test_at) }) : null)]],
      rows, "No SAP user IDs are registered yet.")];
}

// ------------------------------------------------------------------ VM Management
function vmForm(vm, runners, done) {
  const name = inp(vm ? vm.name : "", { required: true, maxlength: "63" });
  const ip = inp(vm ? vm.ip_address || "" : "", { placeholder: "e.g. 10.0.8.25" });
  const acct = inp(vm ? vm.windows_account || "" : "", { maxlength: "64", placeholder: "Windows account the runner runs as (name only)" });
  const notes = h("textarea", { rows: "3", maxlength: "500" }); notes.value = vm ? vm.notes || "" : "";
  const runner = sel(vm ? vm.runner_id || "" : "", [["", "— none —"], ...runners.map((r) => [r.id, `${r.name}${r.mode === "shared" ? " (shared)" : ""}`])]);
  const err = h("div", { class: "error" });
  const save = h("button", { class: "primary", text: vm ? "Save VM" : "Add VM" });
  return h("form", { class: "own", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; save.disabled = true;
    try { await rpc("admin_update_vm_host", { p_id: vm ? vm.id : null, p_name: name.value.trim(), p_ip: ip.value.trim(), p_runner: runner.value || null,
                                             p_windows_account: acct.value.trim(), p_notes: notes.value.trim() }); done(); }
    catch (x) { err.textContent = x.message; save.disabled = false; }
  } }, field("VM name", name), field("IP address", ip), field("BAH runner on this VM", runner), field("Windows account", acct),
     field("Notes", notes), h("p", { class: "hint", text: "No Windows or SAP password is stored: the runner only makes outbound HTTPS calls." }),
     h("div", { class: "actions" }, save, h("button", { type: "button", class: "secondary", text: "Cancel", onclick: done })), err);
}

async function adminVms() {
  const [vms, runners] = await Promise.all([optionalRpc("admin_vm_overview", {}, null),
    api("/runners?select=id,name,mode,status&status=eq.active&order=name")]);
  if (vms === null) return notYet();
  const add = h("button", { class: "primary", text: "Add VM", onclick: () => { slot.replaceChildren(h("div", { class: "card" }, h("h2", { text: "Add VM" }), vmForm(null, runners, () => render()))); } });
  const slot = h("div", {});
  const modeBtn = (v) => {
    if (!v.runner_id || v.runner_status !== "active") return null;
    const toShared = v.runner_mode !== "shared";
    return h("button", { class: toShared ? "primary" : "secondary danger", text: toShared ? "Make this the shared runner" : "Switch to personal runner",
      onclick: async () => {
        const warn = toShared ? `Make ${v.runner_name} the shared BAH runner?\n\nEmployees can then save their SAP passwords for it, and it runs their reports with their own SAP users.`
          : `Switch ${v.runner_name} back to a personal runner?\n\nEvery SAP password saved for it becomes unusable: employees must save it again when a shared runner is available.`;
        if (!confirm(warn)) return;
        try { await rpc("admin_set_execution_mode", { p_runner: v.runner_id, p_mode: toShared ? "shared" : "personal" }); render(); } catch (x) { alert(x.message); }
      } });
  };
  const cards = vms.map((v) => {
    const card = h("div", { class: "card" });
    const edit = h("button", { class: "secondary", text: "Edit", onclick: () => card.replaceChildren(h("h2", { text: `Edit ${v.name}` }), vmForm(v, runners, () => render())) });
    card.append(h("h2", { text: v.name }),
      h("dl", { class: "dl" },
        h("dt", { text: "IP address" }), h("dd", { class: "mono", text: v.ip_address || "—" }),
        h("dt", { text: "Windows account" }), h("dd", { text: v.windows_account || "—" }),
        h("dt", { text: "Notes" }), h("dd", { class: "prewrap", text: v.notes || "—" }),
        h("dt", { text: "Updated" }), h("dd", { text: fmt(v.updated_at) }),
        h("dt", { text: "Runner" }), h("dd", {}, v.runner_name || "— none —", " ", v.runner_mode ? badge(v.runner_mode) : null, " ", v.runner_status && v.runner_status !== "active" ? badge(v.runner_status) : null),
        h("dt", { text: "Status" }), h("dd", {}, v.runner_id ? badge(v.online ? (v.live_permitted ? "online · live allowed" : "online") : "offline") : "—"),
        h("dt", { text: "Last heartbeat" }), h("dd", { text: v.last_heartbeat ? `${fmt(v.last_heartbeat)} (${ago(v.last_heartbeat)})` : "—" }),
        h("dt", { text: "Version" }), h("dd", { text: v.runner_version || "—" }),
        h("dt", { text: "Sealing key" }), h("dd", {}, v.seal_key_configured ? h("span", {}, badge("available"), h("span", { class: "mono", text: ` ${v.seal_key_id}` }), h("div", { class: "muted", text: `since ${fmt(v.seal_key_at)}` }))
                                                       : v.runner_mode === "shared" ? badge("not published yet") : "—"),
        h("dt", { text: "Saved SAP passwords" }), h("dd", { text: v.runner_mode === "shared" ? String(v.sealed_credentials) : "—" }),
        h("dt", { text: "Last successful job" }), h("dd", { text: fmt(v.last_successful_job) })),
      h("div", { class: "actions" }, edit, modeBtn(v)));
    return card;
  });
  return { actions: [add], content: [slot, ...(cards.length ? cards : [h("div", { class: "empty", text: "No VM registered yet." })])] };
}

// ------------------------------------------------------------------ System Jobs
async function adminSystemJobs() {
  const s = await optionalRpc("admin_system_jobs", {}, null);
  if (s === null) return notYet();
  const q = (title, items) => h("div", { class: "card" }, h("h2", { text: title }), h("div", { class: "kpis" }, ...items));
  const oldest = (t) => (t ? `oldest ${ago(t)}` : "none waiting");
  const refresh = h("button", { class: "secondary", text: "Refresh", onclick: () => render() });
  return { actions: [refresh], content: [
    h("div", { class: "card" }, h("h2", { text: "Scheduled database jobs" }), ...table([
      ["Job", (j) => h("strong", { text: j.name })],
      ["Schedule", (j) => h("span", { class: "mono", text: j.schedule })],
      ["Enabled", (j) => badge(j.active ? "enabled" : "not enabled")],
      ["Last run", (j) => h("div", {}, j.last_status ? badge(j.last_status) : "—", ` ${j.last_start ? ago(j.last_start) : ""}`,
        j.last_error ? h("div", { class: "muted", text: j.last_error }) : null)],
      ["Last 24 h", (j) => `${j.runs_24h} runs · ${j.failed_24h} failed`]], s.cron || [], "No scheduled jobs.")),
    h("div", { class: "grid2" },
      q("Report runs", [kpiBox("Queued", s.runs.pending + s.runs.waiting_retry, "warn"), kpiBox("Running", s.runs.running),
        kpiBox("Lease overdue", s.runs.lease_overdue, s.runs.lease_overdue ? "bad" : "ok"),
        kpiBox("Succeeded 24 h", s.runs.succeeded_24h, "ok"), kpiBox("Failed 24 h", s.runs.failed_24h, "bad")]),
      q("Report e-mails", [kpiBox("Queued", s.emails.queued + s.emails.sending, "warn"), kpiBox("Sent 24 h", s.emails.sent_24h, "ok"),
        kpiBox("Failed 24 h", s.emails.failed_24h, "bad")])),
    h("div", { class: "grid2" },
      q("SAP connection tests", [kpiBox("Queued", s.connection_tests.queued, "warn"), kpiBox("Running", s.connection_tests.running),
        kpiBox("Done 24 h", s.connection_tests.done_24h, "ok"), kpiBox("Expired 24 h", s.connection_tests.expired_24h, "bad")]),
      q("Runners", [kpiBox("Active", s.runners.active), kpiBox("Online", s.runners.online, "ok"),
        kpiBox("Shared runner", s.runners.shared_online ? "online" : "offline", s.runners.shared_online ? "ok" : "bad")])),
    h("p", { class: "hint", text: `Oldest queued run: ${oldest(s.runs.oldest_pending_due)} · oldest queued e-mail: ${oldest(s.emails.oldest_queued)} · checked ${fmt(s.checked_at)}.` })] };
}

// ------------------------------------------------------------------ Audit Logs
const AUDIT_ENTITIES = ["sap_credential", "sap_connection_test", "invitation", "registration", "setup_link_issued", "user_status",
  "profiles", "vm_hosts", "runner_mode", "runner_seal_key", "runners", "tasks", "report_templates", "settings", "runner_releases"];
async function adminAudit() {
  const entity = sel("", [["", "All entries"], ...AUDIT_ENTITIES.map((e) => [e, e.replaceAll("_", " ")])]);
  const actorSel = h("select", {});
  const from = h("input", { type: "date" });
  const list = h("div", {});
  const people = await api("/profiles?select=id,full_name&order=full_name");
  actorSel.append(h("option", { value: "", text: "Anyone" }), h("option", { value: "system", text: "System (runner, scheduler)" }),
    ...people.map((p) => h("option", { value: p.id, text: p.full_name })));
  const who = (id) => (id ? (people.find((p) => p.id === id) || {}).full_name || id.slice(0, 8) : "system");
  let before = null;
  const load = async (append) => {
    let q = "/audit_log?select=id,at,actor,action,entity,entity_id,before,after&order=id.desc&limit=100";
    if (entity.value) q += `&entity=eq.${encodeURIComponent(entity.value)}`;
    if (actorSel.value === "system") q += "&actor=is.null"; else if (actorSel.value) q += `&actor=eq.${actorSel.value}`;
    if (from.value) q += `&at=gte.${from.value}T00:00:00Z`;
    if (append && before) q += `&id=lt.${before}`;
    const rows = await api(q);
    before = rows.length ? rows[rows.length - 1].id : before;
    const detail = (r) => (r.before || r.after) ? h("details", {}, h("summary", { text: "details" }),
      h("pre", { class: "prewrap mono", text: JSON.stringify({ before: r.before || undefined, after: r.after || undefined }, null, 1) })) : "—";
    const t = table([["When", (r) => fmt(r.at)], ["Who", (r) => who(r.actor)], ["Action", (r) => r.action],
                     ["What", (r) => h("div", {}, h("strong", { text: r.entity.replaceAll("_", " ") }), r.entity_id ? h("div", { class: "muted mono", text: r.entity_id }) : null)],
                     ["Details", detail]], rows, append ? "No older entries." : "No entries match.");
    if (append) list.append(...t); else list.replaceChildren(...t);
    more.hidden = rows.length < 100;
  };
  const more = h("button", { class: "secondary", text: "Load older", hidden: true, onclick: () => load(true).catch((x) => alert(x.message)) });
  const apply = () => { before = null; load(false).catch((x) => list.replaceChildren(h("div", { class: "notice warn", text: x.message }))); };
  [entity, actorSel, from].forEach((x) => x.addEventListener("change", apply));
  await load(false);
  return [h("div", { class: "card" }, h("div", { class: "grid" }, field("Entry type", entity), field("Who", actorSel), field("From date", from)),
            h("p", { class: "hint", text: "Read-only. Audit entries never contain passwords, sealed credentials or tokens." })), list, more];
}

// ------------------------------------------------------------------ Dynamic Reports (several SAP reports, matched on the runner)
// A dynamic report is a task with report_kind 'dynamic': the same assignments, schedule, central scheduler opt-in,
// Run Now, sealed SAP passwords and e-mail as any task. Its definition (task_configs.config.dynamic) is checked by the
// database on save (bah.dynamic_config_problems) and again by the runner (1.1.0+) before any SAP contact. Scheduled
// runs start only after an administrator opts the report in under Settings > Scheduled reports.
const DYN_TYPES = [["text", "Text"], ["date", "Date"], ["number", "Amount (number)"], ["integer", "Whole number"]];
const dynSources = (c) => (((c || {}).dynamic || {}).sources || []);
const dynSourceText = (c) => dynSources(c).map((s) => `${s.tcode}${s.variant ? ` (${s.variant})` : ""}`).join(" + ") || "—";
// required columns as text, one per line: "Name" or "Name | alias | alias"
const reqToText = (req) => (req || []).map((r) => (typeof r === "string" ? r : [r.name, ...(r.aliases || [])].join(" | "))).join("\n");
const textToReq = (t) => String(t || "").split(/\r?\n/).map((l) => l.split("|").map((x) => x.trim()).filter(Boolean)).filter((p) => p.length)
  .map(([name, ...aliases]) => (aliases.length ? { name, aliases } : name));
const reqNames = (s) => textToReq(s.req.value).map((r) => (typeof r === "string" ? r : r.name));

async function editDynamic(id) {
  const conn = (await api("/app_connections?select=id,code,display_name&status=eq.active"))[0];
  if (!conn) { alert("No active SAP connection configured."); return; }
  let t = { name: "", description: "", execution_target: "live_sap", execution_mode: "scheduled_and_manual", status: "active" };
  let cfg = { report_kind: "dynamic", date_rule: "none", date_fields: [], output: { filename_pattern: "{ReportName}" },
    dynamic: { version: 1, sources: [
      { key: "src1", tcode: "", variant: "", role: "primary", row_key_column: "", required_columns: [] },
      { key: "src2", tcode: "", variant: "", role: "lookup", row_key_column: "", required_columns: [] }],
      extract: { name: "po", source: "src1", column: "", prefix: "", separator: "-", length: 10, missing_value: "Missing" },
      match: { value: "po", lookup: "src2", column: "", length: 10, combine: "distinct_comma" },
      aging: { column: "" }, columns: [], sort: [] } };
  let em = { enabled: false, to: [], cc: [], bcc: [], subject: "", body: "", failure_subject: "", failure_body: "",
             notify_success: true, notify_failure: false, delivery_format: "attachment" };
  let sc = null, asg = [];
  if (id) {
    t = (await api(`/tasks?select=*&id=eq.${id}`))[0];
    const c = (await api(`/task_configs?select=config,email&task_id=eq.${id}`))[0];
    if (c) { cfg = c.config; em = { ...em, ...c.email }; }
    sc = (await api(`/schedules?select=*&task_id=eq.${id}`))[0] || null;
    asg = await api(`/assignments?select=id,employee_id,status&task_id=eq.${id}`);
  }
  const d = cfg.dynamic;
  const f = {
    name: inp(t.name, { maxlength: "120", required: true, placeholder: "e.g. LC Margin Held" }),
    desc: inp(t.description || cfg.report_name || "", { maxlength: "120", required: true, placeholder: "Report name used in e-mails and file names" }),
    mode: sel(t.execution_mode, [["scheduled_and_manual", "Scheduled and manual"], ["manual_only", "Manual Run Now only"], ["scheduled_only", "Scheduled only"]]),
    status: sel(t.status, [["active", "Active"], ["inactive", "Inactive"], ...(t.status === "paused" ? [["paused", "Paused"]] : [])]),
    freq: sel(sc && sc.status !== "inactive" ? sc.frequency : "", [["", "No schedule (manual only)"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]]),
    time: inp(sc ? sc.run_time.slice(0, 5) : "10:30", { type: "time" }),
    weekday: sel(sc && sc.weekday ? String(sc.weekday) : "2", [["1", "Monday"], ["2", "Tuesday"], ["3", "Wednesday"], ["4", "Thursday"], ["5", "Friday"], ["6", "Saturday"], ["7", "Sunday"]]),
    mday: inp(sc && sc.month_day ? sc.month_day : 1, { type: "number", min: "1", max: "31" }),
    eon: chk(em.enabled), esub: inp(em.subject, { maxlength: "200", class: "wide", placeholder: "e.g. {report_name} - {execution_date}" }),
    ebody: h("textarea", { class: "email-body", rows: "6" }),
    efmt: sel(em.delivery_format, [["attachment", "Excel attachment only"], ["body", "Data table in the e-mail body only"], ["both", "Data table and Excel attachment"]]),
    nsucc: chk(em.notify_success), nfail: chk(em.notify_failure),
    // matching and transformation
    xname: inp(d.extract.name, { maxlength: "20" }), xcol: inp(d.extract.column, { maxlength: "80" }),
    xprefix: inp(d.extract.prefix, { maxlength: "10", placeholder: "e.g. 32" }), xsep: inp(d.extract.separator, { maxlength: "3" }),
    xlen: inp(d.extract.length, { type: "number", min: "4", max: "20" }), xmiss: inp(d.extract.missing_value, { maxlength: "20" }),
    mlookup: inp(d.match.lookup, { maxlength: "20" }), mcol: inp(d.match.column, { maxlength: "80" }),
    agecol: inp(d.aging.column, { maxlength: "80" }),
  };
  f.ebody.value = em.body || "";
  const rTo = emailChips((em.to || []), "name@company.com"), rCc = emailChips(em.cc || [], "Add CC"), rBcc = emailChips(em.bcc || [], "Add BCC");

  // ---- SAP source reports (first = primary: one output row per row; the others are lookups)
  const srcBox = h("div", {});
  const sources = [];
  const addSource = (s) => {
    const x = { key: inp(s.key, { maxlength: "20", placeholder: "e.g. fbl3n" }), tcode: inp(s.tcode, { maxlength: "30", placeholder: "e.g. FBL3N" }),
      variant: inp(s.variant || "", { maxlength: "40", placeholder: "e.g. /LC_Margin (empty = none)" }),
      rowkey: inp(s.row_key_column, { maxlength: "80", placeholder: "column that every real row has" }),
      req: h("textarea", { rows: "6", class: "mono", placeholder: "One column per line. Optional other names: Name | other name" }) };
    x.req.value = reqToText(s.required_columns);
    x.card = h("div", { class: "fieldset" });
    const drawCard = () => {
      const primary = sources.indexOf(x) === 0;
      x.card.replaceChildren(h("div", { class: "card-head" }, h("strong", { text: primary ? "Primary report (one output row per row)" : "Lookup report (matched by the extracted value)" }),
        primary || sources.length <= 2 ? null : h("button", { type: "button", class: "small secondary", text: "Remove", onclick: () => { sources.splice(sources.indexOf(x), 1); drawSources(); } })),
        h("div", { class: "grid-3" }, field("Source key", x.key, "Short name used in the mappings below"), field("T-code", x.tcode), field("Variant", x.variant, "Its layout must show every required column")),
        h("div", { class: "grid-2" }, field("Required columns", x.req, "Checked in the SAP layout BEFORE extraction; a missing one stops the run and notifies the employee and administrators."),
          field("Row key column", x.rowkey, "Rows without a value here are SAP total/blank lines and are left out")));
    };
    x.draw = drawCard;
    sources.push(x);
  };
  const drawSources = () => { sources.forEach((x) => x.draw()); srcBox.replaceChildren(...sources.map((x) => x.card)); };
  d.sources.forEach(addSource);
  drawSources();
  const addSrcBtn = h("button", { type: "button", class: "secondary", text: "Add lookup report", onclick: () => {
    if (sources.length >= 5) return; addSource({ key: `src${sources.length + 1}`, tcode: "", variant: "", role: "lookup", row_key_column: "", required_columns: [] }); drawSources(); } });

  // ---- output columns (exact order) + sort
  const outBody = h("tbody", {});
  const outRows = [];
  const valueOptions = () => {
    const opts = [[`extract:${f.xname.value.trim() || "po"}`, `Extracted value (${f.xname.value.trim() || "po"})`], ["aging", "Aging in days (execution date - aging date column)"]];
    for (const s of sources) for (const n of reqNames(s)) opts.push([`${s.key.value.trim()}:${n}`, `${s.tcode.value.trim() || s.key.value.trim()}: ${n}`]);
    return opts;
  };
  const addOut = (c) => {
    const r = { heading: inp(c.heading, { maxlength: "80" }), value: h("select", {}), type: sel(c.type || "text", DYN_TYPES), saved: c.value };
    r.tr = h("tr", {}, h("td", {}, r.heading), h("td", {}, r.value), h("td", {}, r.type),
      h("td", {}, h("div", { class: "actions" },
        h("button", { type: "button", class: "small secondary", text: "↑", "aria-label": "Move up", onclick: () => { const i = outRows.indexOf(r); if (i > 0) { outRows.splice(i - 1, 0, outRows.splice(i, 1)[0]); drawOut(); } } }),
        h("button", { type: "button", class: "small secondary", text: "↓", "aria-label": "Move down", onclick: () => { const i = outRows.indexOf(r); if (i < outRows.length - 1) { outRows.splice(i + 1, 0, outRows.splice(i, 1)[0]); drawOut(); } } }),
        h("button", { type: "button", class: "small secondary", text: "Remove", onclick: () => { outRows.splice(outRows.indexOf(r), 1); drawOut(); } }))));
    outRows.push(r);
  };
  const drawOut = () => {
    const opts = valueOptions();
    for (const r of outRows) {
      const cur = r.value.value || r.saved;
      r.value.replaceChildren(...opts.map(([v, l]) => h("option", { value: v, text: l })),
        ...(cur && !opts.some(([v]) => v === cur) ? [h("option", { value: cur, text: `${cur} (not a required column)` })] : []));
      r.value.value = cur || opts[0][0];
    }
    outBody.replaceChildren(...outRows.map((r) => r.tr));
    const curSort = sortWanted !== null ? sortWanted : f.sortcol.value;     // saved sort on the first draw, then the choice
    sortWanted = null;
    f.sortcol.replaceChildren(h("option", { value: "", text: "SAP order (no sorting)" }), ...outRows.map((r) => h("option", { value: r.heading.value.trim(), text: r.heading.value.trim() || "(no heading)" })));
    f.sortcol.value = outRows.some((r) => r.heading.value.trim() === curSort) ? curSort : "";
  };
  f.sortcol = h("select", {});
  let sortWanted = ((d.sort || [])[0] || {}).heading || "";
  f.sortdir = sel(((d.sort || [])[0] || {}).direction || "desc", [["desc", "Descending (highest first)"], ["asc", "Ascending"]]);
  d.columns.forEach(addOut);
  drawOut();
  const refresh = h("button", { type: "button", class: "secondary", text: "Refresh column choices", onclick: drawOut });
  const addOutBtn = h("button", { type: "button", class: "secondary", text: "Add output column", onclick: () => { addOut({ heading: "", value: "", type: "text" }); drawOut(); } });

  // ---- schedule fields shown for the chosen frequency
  const sWeek = field("Weekday", f.weekday), sMday = field("Day of month", f.mday);
  const syncSched = () => { sWeek.hidden = f.freq.value !== "weekly"; sMday.hidden = f.freq.value !== "monthly"; };
  f.freq.addEventListener("change", syncSched); syncSched();

  let assignBoxes = [];
  const save = h("button", { class: "primary", text: id ? "Save changes" : "Create dynamic report" });
  const picker = employeePicker({
    load: async () => (await api("/profiles?select=id,full_name,email,role,status&order=full_name")).filter((p) => p.status === "active")
      .map((p) => { const a = asg.find((x) => x.employee_id === p.id); return { p, a, box: { checked: !!(a && a.status === "active") } }; }),
    onLoaded: (entries) => { assignBoxes = entries; save.disabled = false; }, onChange: () => {} });

  const build = () => {
    const srcs = sources.map((x, i) => ({ key: x.key.value.trim(), tcode: x.tcode.value.trim().toUpperCase(), variant: x.variant.value.trim(),
      role: i === 0 ? "primary" : "lookup", row_key_column: x.rowkey.value.trim(), required_columns: textToReq(x.req.value) }));
    const len = Number(f.xlen.value);
    const config = { ...cfg, tcode: srcs[0].tcode, report_kind: "dynamic", report_name: f.desc.value.trim(), date_rule: "none", date_fields: [],
      dynamic: { version: 1, sources: srcs,
        extract: { name: f.xname.value.trim(), source: srcs[0].key, column: f.xcol.value.trim(), prefix: f.xprefix.value.trim(),
                   separator: f.xsep.value, length: len, missing_value: f.xmiss.value.trim() || "Missing" },
        match: { value: f.xname.value.trim(), lookup: f.mlookup.value.trim(), column: f.mcol.value.trim(), length: len, combine: "distinct_comma" },
        aging: { column: f.agecol.value.trim() },
        columns: outRows.map((r) => ({ heading: r.heading.value.trim(), value: r.value.value,
                                       ...(r.value.value === "aging" ? { type: "integer" } : r.type.value !== "text" ? { type: r.type.value } : {}) })),
        sort: f.sortcol.value ? [{ heading: f.sortcol.value, direction: f.sortdir.value }] : [] } };
    delete config.variant;                                    // never a top-level variant (older runners)
    return config;
  };
  const preview = h("pre", { class: "prewrap mono" });
  const showJson = h("details", { class: "subsection", ontoggle: () => { preview.textContent = JSON.stringify(build(), null, 1); } },
    h("summary", { text: "Definition as saved (read-only)" }), preview);

  const err = h("div", { class: "err" });
  const form = h("form", { class: "task-form", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; save.disabled = true;
    try {
      if (!f.name.value.trim() || !f.desc.value.trim()) throw new Error("Task name and report name are required.");
      const to = rTo.values(), cc = rCc.values(), bcc = rBcc.values();
      if (rTo.pendingInvalid() || rCc.pendingInvalid() || rBcc.pendingInvalid()) throw new Error("Correct or remove the invalid e-mail addresses first.");
      if (f.eon.checked && !to.length) throw new Error("E-mail is enabled - add at least one 'To' recipient.");
      const config = build();
      const problems = await api("/rpc/dynamic_config_problems", { method: "POST", body: JSON.stringify({ p_config: config }) });
      if (problems && problems.length) throw new Error("Please correct the definition: " + problems.join("; "));
      const row = { name: f.name.value.trim(), description: f.desc.value.trim(), connection_id: conn.id, execution_target: "live_sap",
                    execution_mode: f.mode.value, status: f.status.value, template_id: null, template_version: null };
      const saved = id ? (await api(`/tasks?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(row), headers: { prefer: "return=representation" } }))[0]
                       : (await api("/tasks", { method: "POST", body: JSON.stringify({ ...row, report_kind: "dynamic", created_by: me.user_id }), headers: { prefer: "return=representation" } }))[0];
      const tid = saved.id;
      const email = { ...em, enabled: f.eon.checked, to, cc, bcc, subject: f.esub.value.trim(), body: f.ebody.value,
                      notify_success: f.nsucc.checked, notify_failure: f.nfail.checked, delivery_format: f.efmt.value, format_version: 2 };
      await upsert("task_configs", { task_id: tid, config, email }, "task_id");
      if (f.freq.value) {
        await upsert("schedules", { task_id: tid, frequency: f.freq.value, run_time: f.time.value || "08:00", status: "active",
          weekday: f.freq.value === "weekly" ? Number(f.weekday.value) : null, anchor_date: null,
          month_day: f.freq.value === "monthly" ? Number(f.mday.value) : null, last_day_of_month: false }, "task_id");
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
    pageHead(id ? `Edit dynamic report: ${t.name}` : "New dynamic report", "Several SAP reports, matched and transformed on the shared BAH runner."),
    h("section", { class: "card form-card" }, h("h2", { text: "1. Report details" }),
      h("div", { class: "grid-2" }, field("Task name", f.name), field("Report name", f.desc, "Shown in e-mails ({report_name}) and the workbook name."),
        field("Execution mode", f.mode), field("Status", f.status))),
    h("section", { class: "card form-card" }, h("h2", { text: "2. SAP source reports" }), srcBox, h("div", { class: "actions" }, addSrcBtn)),
    h("section", { class: "card form-card" }, h("h2", { text: "3. Matching and transformation" }),
      h("p", { class: "hint", text: "The value is taken from a text column of the primary report: <prefix><separator><digits> becomes the prefix followed by the digits padded with zeros to the full length (32-4062 -> 3200004062). " +
        "Rows without it are kept and show the 'missing' text. Every primary row stays a separate output row; several lookup rows for one value are combined into one cell (distinct values, comma-separated)." }),
      h("div", { class: "grid-3" }, field("Value name", f.xname), field("Text column (primary report)", f.xcol), field("Prefix", f.xprefix),
        field("Separator", f.xsep), field("Full length (digits)", f.xlen), field("Shown when not found", f.xmiss),
        field("Lookup source key", f.mlookup), field("Lookup column with the same value", f.mcol), field("Aging date column (primary report)", f.agecol, "Aging = execution date minus this date, in days"))),
    h("section", { class: "card form-card" }, h("h2", { text: "4. Output columns (in this order)" }),
      h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Heading", "Value", "Type", ""].map((x) => h("th", { text: x })))), outBody)),
      h("div", { class: "actions" }, addOutBtn, refresh),
      h("div", { class: "grid-2" }, field("Sort by", f.sortcol), field("Direction", f.sortdir)), showJson),
    h("section", { class: "card form-card" }, h("h2", { text: "5. Schedule" }),
      h("div", { class: "grid-3" }, field("Frequency", f.freq), field("Time (Asia/Karachi)", f.time), sWeek, sMday),
      h("p", { class: "hint", text: "Runs on the shared BAH runner. Scheduled runs start only after an administrator opts this report in under Settings > Scheduled reports; until then only Run Now works." })),
    h("section", { class: "card form-card" }, h("h2", { text: "6. Assigned employees" }), picker.el,
      h("p", { class: "hint", text: "SAP is accessed with the run owner's own saved SAP password; each source report uses the same SAP user." })),
    h("section", { class: "card form-card" }, h("div", { class: "card-head" }, h("h2", { text: "7. E-mail" }), h("label", { class: "toggle" }, f.eon, " Send report e-mail")),
      h("div", { class: "grid-1" }, field("To", rTo.el), field("CC", rCc.el), field("BCC", rBcc.el)),
      h("div", { class: "grid-2" }, field("Delivery format", f.efmt), h("div", {})), field("Subject", f.esub),
      h("label", { class: "field" }, "Body", placeholderBar(f.ebody), f.ebody),
      h("div", { class: "grid-2" }, field("Send the report e-mail when the run succeeds", f.nsucc), field("Send a failure e-mail when the run fails", f.nfail)),
      h("p", { class: "hint", text: "Missing layout columns are always reported to the assigned employee(s) and the administrators, whatever is set here." })),
    err,
    h("div", { class: "sticky-actions" }, h("span", { class: "hint", text: id ? "Changes apply to future runs." : "" }),
      h("div", { class: "actions" }, h("button", { type: "button", class: "secondary", text: "Cancel", onclick: () => render() }), save)));
  mainArea().replaceChildren(form);
  save.disabled = true;
  picker.start();
}

Object.assign(ADMIN_VIEWS, { admin_people: adminPeopleV2, admin_invitations: adminInvitations, admin_credentials: adminCredentials,
  admin_vms: adminVms, admin_system: adminSystemJobs, admin_audit: adminAudit });
