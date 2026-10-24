# Valet Removals — Integrated Phase 1 + Phase 2 development

## Milestone 1 (in progress; NOT production-ready)

The root `index.html`, `styles.css`, and `app.js` are unchanged from the deployed Phase 1. The existing Make webhook is preserved. This is deliberately a safe starting point: **the website is not yet connected to the new backend**.

The `server/` directory introduces a Node/Express API for a future Render Web Service and `db/001_initial.sql` introduces the PostgreSQL schema. The admin endpoints require an authenticated cookie; login credentials are bcrypt-hashed, and sessions are stored by hash in PostgreSQL.

The pricing calculation in `server/logic.js` reproduces the rules supplied in Barry's `pricing.js`. The original prototype app and journey styles are saved as `prototype-app.reference.js` and `journey.css` for fidelity checks; the original HTML is saved as `prototype-index.reference.html`.

### Still required before any real deployment

- Integrate the existing Phase 1 form with `/api/enquiries` **without duplicate or lost Make notifications**; decide retry/idempotency behavior.
- Implement Barry's owner desk and customer screens as live, authenticated interfaces; no demo notices.
- Implement the remaining `journey.js` state transitions in transactional API routes: sending through Make, viewed/accepted, change requests and approvals, revisions, customer messages and booking confirmations.
- Configure customer quote access with securely generated opaque tokens, expiry and revision checks.
- Handle image uploads in durable private object storage, not browser blob URLs or unrestricted database JSON.
- Protect the admin with CSRF defenses and ensure same-origin routing through the final domain; do not expose API/database credentials in frontend code.
- Add migrations runner, tests, deployment and backup/restore verification. Validate email sending through Make end-to-end.
- Private staging deployment before merging into `main`.

### Local setup (when database is provisioned)

1. `npm install`
2. Apply `db/001_initial.sql` to the private PostgreSQL database.
3. Set `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` as secure environment variables.
4. Run `node server/setup-admin.js` once.
5. `npm start` to run the backend.

Do not set DNS or change Render's existing Static Site until staging tests pass.
