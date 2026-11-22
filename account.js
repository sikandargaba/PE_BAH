// BAH portal - the signed-in person's own account: registration, My SAP Credentials, My Profile.
// Loaded after admin.js and before app.js; uses app.js helpers (h, api, badge, fmt, authPanel...) at call time only.
// SAP passwords: typed into a password field, sealed in this browser (seal.js) for the shared BAH runner, sent once as
// ciphertext, and the field is cleared. Nothing is kept in storage, cookies or page state; the database never returns
// a stored credential - only its status.
"use strict";

const TERMS_VERSION = "2026-11";
const USAGE_POLICY = [
  "BAH runs SAP reports for you with your own SAP user ID. You may only save your own SAP password.",
  "Your SAP password is encrypted in this browser for the shared BAH runner before it leaves your PC. Nobody - including BAH administrators - can read it back.",
  "Reports produced by BAH are company information. Share them only with people entitled to see them.",
  "Change your password here whenever you change it in SAP. Remove it here if you no longer want BAH to run reports for you.",
  "Your actions in BAH (sign-in, saved or removed credentials, runs, downloads) are recorded in the audit log.",
  "Tell the BAH administrator immediately if you suspect misuse of your account.",
];
const SAP_TEST_TEXT = {
  ok: "SAP sign-in succeeded.",
  invalid_credentials: "SAP refused the user ID or password - save the correct password and test again.",
  locked: "Your SAP user is locked - ask the SAP team to unlock it, then test again.",
  expired_password: "Your SAP password has expired - change it in SAP, then save the new one here.",
  unavailable: "SAP was not reachable from the BAH runner - try again later.",
  network: "Network problem between the BAH runner and SAP - try again later.",
  authorization: "Your SAP user may not use the SAP web GUI - ask the SAP team.",
  error: "The test could not be completed - try again later.",
};
const CRED_STATUS = { configured: ["saved", "ok"], not_configured: ["not saved", "warn"], reenter: ["re-enter required", "bad"] };
const credBadge = (s) => { const [t, c] = CRED_STATUS[s] || [s || "—", ""]; return h("span", { class: `badge ${c}`, text: t }); };
const testBadge = (r) => (r ? h("span", { class: `badge ${r === "ok" ? "ok" : "bad"}`, text: r === "ok" ? "passed" : "failed" }) : badge("not tested"));

async function rpc(name, args = {}) { return api(`/rpc/${name}`, { method: "POST", body: JSON.stringify(args) }); }
// Functions added by the shared-runner database change; before it is applied (or after a rollback, which revokes
// them) the portal behaves exactly as before.
async function optionalRpc(name, args, fallback) {
  try { return await rpc(name, args); }
  catch (x) { if (/could not find the function|schema cache|permission denied for function/i.test(x.message)) return fallback; throw x; }
}
const myCredentialRows = () => optionalRpc("my_sap_credential_status", {}, null);       // null: feature not available
const sharedRunnerInUse = (rows) => !!rows && rows.some((r) => r.credential_status === "configured");
async function signOutEverywhere() {
  try { await fetch(`${AUTH}/logout?scope=local`, { method: "POST", headers: { apikey: KEY, authorization: `Bearer ${session.access_token}` } }); } catch { /* ignore */ }
  signOutLocal();
}

// ------------------------------------------------------------------ registration (invited accounts, first sign-in)
async function pendingRegistration() {
  const s = await optionalRpc("my_registration_status", {}, null);
  return s && !s.registered && s.invitation_status ? s : null;            // accounts never invited are registered
}

function renderRegistration(s) {
  const out = h("button", { type: "button", class: "secondary", text: "Sign out", onclick: signOutEverywhere });
  if (s.invitation_status !== "pending") {
    const why = s.invitation_status === "expired" ? "Your invitation has expired." : "Your invitation is no longer valid.";
    authPanel("Complete your registration", h("div", {}, h("div", { class: "notice warn", text: `${why} Ask the BAH administrator for a new invitation.` }), out));
    return;
  }
  const name = h("input", { type: "text", autocomplete: "name", maxlength: "120", required: true, value: s.full_name || "" });
  const accept = h("input", { type: "checkbox", required: true });
  const err = h("div", { class: "error" });
  const btn = h("button", { class: "primary", text: "Complete registration" });
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    if (!name.value.trim()) { err.textContent = "Enter your full name."; return; }
    if (!accept.checked) { err.textContent = "Accept the BAH usage policy to continue."; return; }
    btn.disabled = true;
    try { await rpc("complete_my_registration", { p_full_name: name.value.trim(), p_accept_terms: true, p_terms_version: TERMS_VERSION }); await start(); }
    catch (x) { err.textContent = x.message; btn.disabled = false; }
  } },
    h("p", { class: "hint", text: `Signed in as ${s.email}. One step left before you can use BAH.` }),
    h("label", { class: "field" }, "Full name", name),
    h("div", { class: "field" }, h("strong", { text: `BAH usage policy (version ${TERMS_VERSION})` }),
      h("ul", { class: "policy" }, USAGE_POLICY.map((t) => h("li", { text: t })))),
    h("label", { class: "field check" }, accept, " I have read and accept the BAH usage policy."),
    btn, err,
    s.invitation_expires_at ? h("p", { class: "hint", text: `Invitation valid until ${fmt(s.invitation_expires_at)}.` }) : null);
  authPanel("Complete your registration", form, out);
  name.focus();
}

// ------------------------------------------------------------------ My SAP Credentials
async function sapCredentialsPage() {
  const rows = await myCredentialRows();
  if (rows === null) return [h("div", { class: "notice", text: "SAP passwords are currently stored by the BAH Runner on your own PC (BAH Runner Setup). Saving them here becomes available when the shared BAH runner is enabled." })];
  if (!rows.length) return [h("div", { class: "notice warn", text: "No SAP connection is set up in BAH yet." })];
  return [h("div", { class: "notice", text: "Your SAP password is encrypted in this browser for the shared BAH runner before it is sent. It is never shown again - not to you and not to administrators. Re-enter it here whenever you change it in SAP." }),
          ...rows.map(credentialCard)];
}

function credentialCard(row) {
  const card = h("div", { class: "card" });
  const refresh = async () => {
    try {
      const all = await rpc("my_sap_credential_status");
      const next = all.find((x) => x.connection_id === row.connection_id);
      if (card.isConnected && next) card.replaceWith(credentialCard(next));
    } catch (x) { msg.className = "error"; msg.textContent = x.message; }
  };
  const msg = h("div", { class: "hint" });
  const say = (cls, text) => { msg.className = cls; msg.textContent = text; };
  const haveId = row.sap_user_id && row.identity_status === "active";
  const result = row.credential_status === "configured" && !row.test_pending ? row.last_test_result : null;   // a test of a usable password only
  card.append(h("h2", { text: row.connection || "SAP" }), h("dl", { class: "dl" },
    h("dt", { text: "SAP user ID" }), h("dd", { class: "mono", text: row.sap_user_id || "not registered" }),
    h("dt", { text: "SAP password" }), h("dd", {}, credBadge(row.credential_status)),
    h("dt", { text: "Last saved" }), h("dd", { text: fmt(row.updated_at) }),
    h("dt", { text: "Connection test" }), h("dd", {}, row.test_pending ? badge("pending") : testBadge(result),
      result && row.last_test_at ? ` ${fmt(row.last_test_at)}` : "")));
  if (!haveId) {
    card.append(h("div", { class: "notice warn", text: "No active SAP user ID is registered for you on this connection. Ask the BAH administrator to register it." }));
    return card;
  }
  if (row.credential_status === "reenter") card.append(h("div", { class: "notice warn", text: "The shared BAH runner received a new key, so your saved password can no longer be used. Enter it again." }));
  if (result && result !== "ok") card.append(h("div", { class: "notice warn", text: SAP_TEST_TEXT[result] || SAP_TEST_TEXT.error }));
  if (result === "ok") card.append(h("div", { class: "hint ok-text", text: SAP_TEST_TEXT.ok }));

  // password form (shown on demand once a password is saved)
  const pw1 = h("input", { type: "password", autocomplete: "new-password", maxlength: "200", spellcheck: "false", required: true });
  const pw2 = h("input", { type: "password", autocomplete: "new-password", maxlength: "200", spellcheck: "false", required: true });
  const save = h("button", { class: "primary", text: "Encrypt and save" });
  const clear = () => { pw1.value = ""; pw2.value = ""; };
  const form = h("form", { class: "cred", autocomplete: "off", hidden: row.credential_status === "configured", onsubmit: async (e) => {
    e.preventDefault(); say("hint", "");
    if (!pw1.value) { say("error", "Enter your SAP password."); return; }
    if (pw1.value !== pw2.value) { clear(); say("error", "The two passwords differ - type them again."); return; }
    save.disabled = true; say("hint", "Encrypting in your browser…");
    try {
      const target = await rpc("my_seal_target", { p_connection: row.connection_id });
      const envelope = await BAHSeal.sealSapPassword(target, pw1.value);
      clear();
      say("hint", "Saving…");
      await rpc("save_my_sap_credential", { p_connection: row.connection_id, p_sap_user_id: target.sap_user_id,
                                             p_runner: target.runner_id, p_key_id: target.key_id, p_envelope: envelope });
      await refresh();
    } catch (x) { say("error", `Not saved: ${x.message}`); }
    finally { clear(); save.disabled = false; }
  } },
    h("label", { class: "field" }, `SAP password for ${row.sap_user_id}`, pw1),
    h("label", { class: "field" }, "Repeat the SAP password", pw2),
    h("div", { class: "actions" }, save, row.credential_status === "configured"
      ? h("button", { type: "button", class: "secondary", text: "Cancel", onclick: () => { clear(); form.hidden = true; } }) : null));

  const actions = h("div", { class: "actions" });
  if (row.credential_status === "configured") {
    actions.append(
      h("button", { type: "button", class: "primary", text: "Test SAP connection", disabled: !!row.test_pending, onclick: async (e) => {
        e.target.disabled = true; say("hint", "Requesting a test…");
        try { await rpc("request_my_sap_test", { p_connection: row.connection_id }); await refresh(); }
        catch (x) { say("error", x.message); e.target.disabled = false; }
      } }),
      h("button", { type: "button", class: "secondary", text: "Replace password", onclick: () => { form.hidden = false; pw1.focus(); } }));
  }
  if (row.credential_status !== "not_configured") {
    actions.append(h("button", { type: "button", class: "secondary danger", text: "Remove", onclick: async (e) => {
      if (!confirm(`Remove your saved SAP password for ${row.connection || "SAP"}?\n\nBAH can then no longer run SAP reports for you until you save it again.`)) return;
      e.target.disabled = true;
      try { await rpc("remove_my_sap_credential", { p_connection: row.connection_id }); await refresh(); }
      catch (x) { say("error", x.message); e.target.disabled = false; }
    } }));
  }
  if (row.test_pending) {
    say("hint", "Testing: the shared BAH runner signs in to SAP with your user and signs out again (nothing is changed in SAP)…");
    setTimeout(() => { if (card.isConnected) refresh(); }, 5000);
  }
  card.append(actions, form, msg);
  return card;
}

// ------------------------------------------------------------------ My Profile
async function profilePage() {
  const [prof, reg, creds] = await Promise.all([
    api(`/profiles?select=full_name,email,role,status&id=eq.${me.user_id}`).then((r) => r[0] || {}),
    optionalRpc("my_registration_status", {}, null), myCredentialRows().catch(() => null)]);
  const p1 = h("input", { type: "password", autocomplete: "new-password", minlength: "12", required: true });
  const p2 = h("input", { type: "password", autocomplete: "new-password", minlength: "12", required: true });
  const err = h("div", { class: "error" });
  const btn = h("button", { class: "primary", text: "Change BAH password" });
  const pwForm = h("form", { class: "own", onsubmit: async (e) => {
    e.preventDefault(); err.className = "error"; err.textContent = "";
    const bad = p1.value !== p2.value ? "Passwords differ."
      : p1.value.length < 12 || !/[A-Za-z]/.test(p1.value) || !/[0-9]/.test(p1.value) ? "At least 12 characters with letters and digits." : "";
    if (bad) { err.textContent = bad; return; }
    btn.disabled = true;
    try {
      const r = await fetch(`${AUTH}/user`, { method: "PUT", headers: { apikey: KEY, authorization: `Bearer ${await token()}`, "content-type": "application/json" },
                                             body: JSON.stringify({ password: p1.value }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.msg || j.message || "The password was refused."); }
      err.className = "hint ok-text"; err.textContent = "BAH password changed.";
    } catch (x) { err.textContent = x.message; }
    finally { p1.value = p2.value = ""; btn.disabled = false; }
  } }, h("label", { class: "field" }, "New BAH password (min. 12, letters and digits)", p1),
     h("label", { class: "field" }, "Repeat", p2), btn, err,
     h("p", { class: "hint", text: "This is your BAH portal password, not your SAP password. SAP passwords are managed under My SAP Credentials." }));
  return [
    h("div", { class: "grid2" },
      h("div", { class: "card" }, h("h2", { text: "Account" }), h("dl", { class: "dl" },
        h("dt", { text: "Name" }), h("dd", { text: prof.full_name || "—" }),
        h("dt", { text: "E-mail" }), h("dd", { text: prof.email || "—" }),
        h("dt", { text: "Role" }), h("dd", { text: ROLE_LABEL() }),
        h("dt", { text: "Status" }), h("dd", {}, badge(prof.status)),
        reg ? h("dt", { text: "Usage policy" }) : null,
        reg ? h("dd", { text: reg.terms_version ? `accepted (version ${reg.terms_version})` : "—" }) : null)),
      h("div", { class: "card" }, h("h2", { text: "SAP user IDs" }), creds && creds.length
        ? h("dl", { class: "dl" }, creds.flatMap((c) => [h("dt", { text: c.connection || "SAP" }),
            h("dd", {}, h("span", { class: "mono", text: c.sap_user_id || "not registered" }), " ", credBadge(c.credential_status))]))
        : h("div", { class: "empty", text: "Registered by the BAH administrator." }))),
    h("div", { class: "card" }, h("h2", { text: "BAH password" }), pwForm)];
}

const ACCOUNT_VIEWS = { sap_credentials: sapCredentialsPage, profile: profilePage };
