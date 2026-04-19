# Shopping list app

Shared household shopping list app with:

- one live list per household
- hidden completed items with quick re-add
- email-code sign-in
- email-style household invites
- local black-box E2E coverage

## Run locally

```bash
npm install
npm run dev
```

Frontend runs on `http://127.0.0.1:4173` and the API on `http://127.0.0.1:4000`.

## Test locally

```bash
npm run test
```

That runs unit tests and Playwright E2E tests against a locally started full app stack.
