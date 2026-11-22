// BAH - sealing an SAP password in the browser for the shared BAH runner (no third-party code; Web Crypto only).
// The password is encrypted with a fresh AES-256-GCM key; that key is wrapped with the shared runner's RSA-3072 public key
// (RSA-OAEP, SHA-256). Only the runner's private key (DPAPI-protected on the VM) can open it. The additional data binds
// the ciphertext to this employee, this SAP connection and this SAP user ID, so a copied envelope is useless for anyone else.
// Nothing here is stored: the password exists only in the form field and in this function's local variables.
//
// Envelope (stored by bah.save_my_sap_credential, opened only by the runner):
//   {"v":1,"alg":"RSA-OAEP-256+A256GCM","kid":<16 hex>,"wk":b64(RSA-OAEP(aes key)),"iv":b64(12 bytes),"ct":b64(AES-GCM(json)+tag)}
//   plaintext = {"password": "..."}, additionalData = target.aad = "bah-sap-v1|<employee>|<connection>|<SAP USER>"
"use strict";

(function (root) {
  const ALG = "RSA-OAEP-256+A256GCM";
  const AAD_RE = /^bah-sap-v1\|[0-9a-f-]{36}\|[0-9a-f-]{36}\|[A-Z0-9._@-]{1,40}$/;
  const b64 = (buf) => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function keyIdOf(spkiDer) {               // same as the database: first 16 hex of SHA-256(SPKI DER)
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", spkiDer));
    return Array.from(d.slice(0, 8), (x) => x.toString(16).padStart(2, "0")).join("");
  }

  // target = bah.my_seal_target(...) result. Returns the envelope; throws (without the password) on any mismatch.
  async function sealSapPassword(target, password) {
    if (!root.crypto || !crypto.subtle) throw new Error("This browser cannot encrypt securely - use a current Edge or Chrome.");
    if (!target || target.alg !== ALG || !/^[0-9a-f]{16}$/.test(target.key_id || "") || !AAD_RE.test(target.aad || ""))
      throw new Error("The shared runner's key information is incomplete - reload the page.");
    if (typeof password !== "string" || password.length < 1 || password.length > 200)
      throw new Error("Enter your SAP password (at most 200 characters).");
    const der = unb64(target.public_key);
    if (await keyIdOf(der) !== target.key_id) throw new Error("The shared runner's key does not match its fingerprint - reload the page.");
    const rsa = await crypto.subtle.importKey("spki", der, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
    if (!rsa.algorithm || rsa.algorithm.modulusLength < 3072) throw new Error("The shared runner's key is too weak.");
    const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(target.aad), tagLength: 128 },
                                           aes, new TextEncoder().encode(JSON.stringify({ password })));
    const wk = await crypto.subtle.wrapKey("raw", aes, rsa, { name: "RSA-OAEP" });
    return { v: 1, alg: ALG, kid: target.key_id, wk: b64(wk), iv: b64(iv), ct: b64(ct) };
  }

  root.BAHSeal = Object.freeze({ sealSapPassword, keyIdOf, ALG });
})(typeof window !== "undefined" ? window : globalThis);
