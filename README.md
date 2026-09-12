# Goals FC Trial Portal

## Render deployment

This version uses PostgreSQL for persistent player registrations. The old `data/players.json` file is only used once to migrate any existing registrations into an empty PostgreSQL database.

### Environment variables

Set these in the Render web service:

- `DATABASE_URL` — your Render PostgreSQL internal/external connection string
- `ADMIN_PASSWORD` — the admin login password
- `SESSION_SECRET` — a long random secret used to sign admin sessions

`PORT` is supplied by Render automatically.

### Build / start

Build command:

```text
npm install
```

Start command:

```text
npm start
```

### Health check

After deployment, open:

`/api/health`

A healthy deployment returns:

```json
{"ok":true,"database":"connected"}
```

If `DATABASE_URL` is missing or the database cannot be reached, the service will fail its startup rather than silently accepting registrations that cannot be persisted.
