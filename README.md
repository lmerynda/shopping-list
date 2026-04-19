# Shopping list app

Shared household shopping list app with:

- one live list per household
- hidden completed items with quick re-add
- email-code sign-in
- email-style household invites
- local black-box E2E coverage
- Postgres-backed backend

## Run locally

```bash
npm install
npm run db:up
npm run migrate
npm run dev
```

Frontend runs on `http://127.0.0.1:4173`, the API on `http://127.0.0.1:4000`, and Postgres on `127.0.0.1:54329`.

For frontend deployments, set:

```bash
VITE_API_URL=https://your-backend.up.railway.app
```

## Test locally

```bash
npm run test
```

That runs unit tests and Playwright E2E tests against a locally started app stack plus a disposable Postgres Docker container.

## Railway

The repo includes [railway.json](/repos/shopping-list/railway.json) for Railway config-as-code.

Expected Railway variables:

```bash
DATABASE_URL=<Railway Postgres connection string>
CLIENT_ORIGIN=<your frontend origin>
PORT=4000
```

Recommended deployment shape:

- Railway service for the backend app
- Railway PostgreSQL service in the same project
- frontend hosted separately and pointed at the backend URL
