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
          h("p", { class: "hint", text: "Prefer e-mail? After 2 minutes use Resend e-mail under Invitations (a new link replaces this one)." }));
      } else out.append(h("p", { class: "hint", text: "No link was generated - use Resend e-mail under Invitations." }));
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
    h("div", { class: "notice", text: "Create accounts under Employees → Invite employee. Resend e-mail sends a new one-time setup link to the registered address and extends the invitation by 7 days." }),
    ...table([
      ["Person", (v) => h("div", {}, h("strong", { text: v.full_name }), h("div", { class: "muted", text: v.email }))],
      ["Status", (v) => h("span", { class: `badge ${v.status === "accepted" ? "ok" : v.status === "pending" ? "info" : "bad"}`, text: INVITE_BADGE[v.status] || v.status })],
      ["Invited", (v) => h("div", {}, fmt(v.created_at), h("div", { class: "muted", text: v.invited_by ? `by ${v.invited_by}` : "" }))],
      ["Last sent", (v) => h("div", {}, fmt(v.last_sent_at), h("div", { class: "muted", text: `${v.send_count} time(s)` }))],
      ["Expires / closed", (v) => v.status === "accepted" ? `registered ${fmt(v.accepted_at)}` : v.status === "revoked" ? `revoked ${fmt(v.revoked_at)}` : fmt(v.expires_at)],
      ["", (v) => {
        if (v.status === "accepted" || v.status === "revoked") return null;
        const msg = h("div", { class: "hint" });
        const resend = h("button", { class: "secondary small", text: "Resend e-mail", onclick: async () => {
          if (!confirm(`E-mail a new setup link to ${v.full_name} (${v.email})?\n\nAny earlier link stops working; the invitation is extended by 7 days.`)) return;
          resend.disabled = true; msg.className = "hint"; msg.textContent = "Sending…";
          try { await fnPost("admin-setup-link", { user_id: v.user_id, kind: "setup", deliver: "email" }); msg.className = "hint ok-text"; msg.textContent = "Sent."; setTimeout(render, 1500); }
          catch (x) { msg.className = "error"; msg.textContent = x.message; resend.disabled = false; }
        } });
        const revoke = v.status === "pending" ? h("button", { class: "secondary small danger", text: "Revoke", onclick: async () => {
          if (!confirm(`Revoke the invitation for ${v.full_name}?\n\nThe account is deactivated, so the link and any password set with it stop working.`)) return;
          try { await rpc("admin_revoke_invitation", { p_invitation: v.id }); render(); } catch (x) { msg.className = "error"; msg.textContent = x.message; }
        } }) : null;
        return h("div", {}, h("div", { class: "actions" }, resend, revoke), msg);
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

// ------------------------------------------------------------------ Runner Monitoring
async function adminRunners() {
  const since = new Date(Date.now() - 86400000).toISOString();
  const [runners, people, execs, latestRows] = await Promise.all([
    api("/runners?select=id,employee_id,name,status,mode,version,live_permitted,live_sap_user,busy,last_seen_at,registered_at,revoked_at&order=status,name"),
    api("/profiles?select=id,full_name"),
    api(`/executions?select=runner_id,status,finished_at,error_class&finished_at=gte.${since}&order=finished_at.desc&limit=1000`),
    api("/rpc/release_latest_stable", { method: "POST", body: "{}" }).catch(() => [])]);
  const latest = (latestRows || [])[0] || null;
  const who = (id) => (people.find((p) => p.id === id) || {}).full_name || "—";
  const mine = (r) => execs.filter((e) => e.runner_id === r.id);
  const active = runners.filter((r) => r.status === "active");
  return [
    h("div", { class: "card" }, h("h2", { text: "Runners" }), h("div", { class: "kpis" },
      kpiBox("Active", active.length), kpiBox("Online", active.filter((r) => isOnline(r.last_seen_at)).length, "ok"),
      kpiBox("Offline", active.filter((r) => !isOnline(r.last_seen_at)).length, "warn"),
      kpiBox("Shared online", active.filter((r) => r.mode === "shared" && isOnline(r.last_seen_at)).length, active.some((r) => r.mode === "shared" && isOnline(r.last_seen_at)) ? "ok" : "bad"),
      kpiBox("Failed jobs (24 h)", execs.filter((e) => e.status === "failed").length, "bad"))),
    ...table([
      ["Runner", (r) => h("div", {}, h("strong", { text: r.name }), h("div", { class: "muted", text: `registered to ${who(r.employee_id)}` }))],
      ["Mode", (r) => badge(r.mode || "personal")],
      ["State", (r) => r.status !== "active" ? h("div", {}, badge(r.status), h("div", { class: "muted", text: fmt(r.revoked_at) }))
        : h("div", {}, badge(isOnline(r.last_seen_at) ? (r.busy ? "online · busy" : "online") : "offline"), r.live_permitted ? h("div", { class: "muted", text: "live SAP allowed" }) : null)],
      ["Last heartbeat", (r) => h("div", {}, ago(r.last_seen_at), h("div", { class: "muted", text: fmt(r.last_seen_at) }))],
      ["Version", (r) => { const [s, c] = runnerState(r.version, latest); return h("div", {}, String(r.version || "—").replace(/^cloud-/, ""), " ", r.status === "active" ? h("span", { class: `badge ${c}`, text: s }) : null); }],
      ["Jobs (24 h)", (r) => { const e = mine(r); if (!e.length) return "—";
        return h("div", {}, `${e.filter((x) => x.status === "succeeded").length} ok · ${e.filter((x) => x.status === "failed").length} failed`,
          h("div", { class: "muted", text: `last ${fmt(e[0].finished_at)}${e[0].error_class ? " - " + e[0].error_class : ""}` })); }]],
      runners, "No runners registered.")];
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

Object.assign(ADMIN_VIEWS, { admin_people: adminPeopleV2, admin_invitations: adminInvitations, admin_credentials: adminCredentials,
  admin_vms: adminVms, admin_runners: adminRunners, admin_system: adminSystemJobs, admin_audit: adminAudit });
