# PE BAH – web portal (GitHub Pages)

Static site (no build step): `index.html`, `admin.js`, `app.js`, `app.css`, `.nojekyll`.
It contains only the **public** Supabase key; all access control is enforced by Supabase Auth and
row-level security. No service-role key, SAP, SMTP or other secrets are, or may ever be, in this repository.

## Deploy (repository `PE_BAH`)
1. Create the repository `PE_BAH` (public: required for GitHub Pages on a free account).
2. Copy the five files above to the repository root, commit, push.
3. Repository → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
4. Site address: `https://<github-user>.github.io/PE_BAH/` (all paths are relative, so the
   repository sub-path works).

## One-time Supabase settings (Supabase dashboard of the BAH project)
- Authentication → URL Configuration → **Site URL** = the site address above; add it to **Redirect URLs**.
  One-time setup/recovery links then open the portal's "Set your BAH password" page.
- Optional hardening: Edge Functions → Secrets → `BAH_PORTAL_ORIGIN` = `https://<github-user>.github.io`
  (restricts the report-download function to this site).

Sign-up stays disabled and MFA stays off; accounts are created only by the administrator.
