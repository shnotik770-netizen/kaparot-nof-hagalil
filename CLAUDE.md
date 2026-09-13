# כפרות נוף הגליל — הנחיות לעבודה

## Stack
Node.js + Express + PostgreSQL (`pg`). Frontend: vanilla HTML/JS (`public/index.html`
customer app, `public/kiosk.html` distribution kiosk, `public/admin.html` admin panel),
Hebrew RTL, no build step. Deployed on Railway via `git push` to `main` (no PRs, direct push).

## Strict rules
- Only read and edit files directly related to the current task. Do not scan the
  whole repo "just in case."
- Never run broad recursive searches across the entire workspace — grep/glob with a
  narrow, specific pattern and path instead.
- Prefer targeted `Read` with `offset`/`limit` over reading whole large files
  (`public/admin.html` and `public/index.html` are large).
- Real secrets (Nedarim ApiValid/Mosad/webhook secret, Yemot SMS key, DB creds) live
  only in Railway env vars — never commit them.
- Every commit message ends with the Co-Authored-By/Claude-Session trailer given in
  the system prompt for this session.
