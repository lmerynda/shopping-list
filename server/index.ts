import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { isMailEnabled, sendLoginCodeEmail } from "./mailer.js";
import { AppStore } from "./store.js";
import {
  addItemSchema,
  createListSchema,
  requestCodeSchema,
  shareSettingsSchema,
  updateItemSchema,
  verifyCodeSchema,
} from "./schema.js";

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

app.use(express.json());

function isLocalDevelopmentOrigin(origin: string | undefined) {
  if (!origin || config.nodeEnv === "production") {
    return false;
  }

  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const requestOrigin = req.header("origin");
  const isAllowedOrigin =
    !requestOrigin ||
    requestOrigin === config.clientOrigin ||
    isLocalDevelopmentOrigin(requestOrigin) ||
    (config.clientOriginRegex ? config.clientOriginRegex.test(requestOrigin) : false);

  if (isAllowedOrigin && requestOrigin) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Vary", "Origin");
  } else if (!requestOrigin) {
    res.setHeader("Access-Control-Allow-Origin", config.clientOrigin);
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    if (!isAllowedOrigin) {
      res.status(403).end();
      return;
    }
    res.status(204).end();
    return;
  }

  if (!isAllowedOrigin) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  next();
});

function getToken(req: express.Request) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice("Bearer ".length);
}

function requireUser(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userId = store.getUserIdFromToken(getToken(req));
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as express.Request & { userId: number }).userId = userId;
  next();
}

type Client = { ws: import("ws").WebSocket; userId: number; listId: number };
const clients = new Set<Client>();

function broadcastList(listId: number) {
  for (const client of clients) {
    if (client.listId === listId && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify({ type: "list-updated", listId }));
    }
  }
}

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const token = url.searchParams.get("token") ?? undefined;
  const listId = Number(url.searchParams.get("listId"));
  const userId = store.getUserIdFromToken(token);

  if (!userId || !listId) {
    ws.close();
    return;
  }

  try {
    await store.ensureListAccess(userId, listId);
  } catch {
    ws.close();
    return;
  }

  const client = { ws, userId, listId };
  clients.add(client);
  ws.on("close", () => {
    clients.delete(client);
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/test/reset", (_req, res) => {
  if (process.env.NODE_ENV !== "test") {
    res.status(404).end();
    return;
  }
  void store.resetForTests()
    .then(() => {
      res.status(204).end();
    })
    .catch(() => {
      res.status(500).json({ error: "Unable to reset test state" });
    });
});

app.post("/api/auth/request-code", async (req, res) => {
  const parsed = requestCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const code = await store.requestMagicCode(parsed.data.email, parsed.data.displayName);
  let emailed = false;
  try {
    emailed = await sendLoginCodeEmail({ email: parsed.data.email, code });
  } catch (error) {
    console.error("Failed to send login code email", error);
    res.status(502).json({ error: "Code created, but email delivery failed" });
    return;
  }

  if (!emailed && process.env.NODE_ENV === "production") {
    res.status(503).json({ error: "Email delivery is not configured" });
    return;
  }

  res.json({
    ok: true,
    emailed,
    mailConfigured: isMailEnabled(),
    devCode: process.env.NODE_ENV !== "production" ? code : undefined,
  });
});

app.post("/api/auth/verify", async (req, res) => {
  const parsed = verifyCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const session = await store.verifyMagicCode(parsed.data.email, parsed.data.code);
  if (!session) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }
  res.json(session);
});

app.post("/api/test/login", async (req, res) => {
  if (config.nodeEnv === "production") {
    res.status(404).end();
    return;
  }
  const parsed = requestCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = await store.devLogin(parsed.data.email, parsed.data.displayName);
  res.json(result);
});

app.get("/api/session", requireUser, async (req, res) => {
  const userId = (req as express.Request & { userId: number }).userId;
  res.json(await store.getSessionPayload(userId));
});

app.get("/api/share-settings", requireUser, async (req, res) => {
  const userId = (req as express.Request & { userId: number }).userId;
  res.json({ emails: await store.getDefaultShareEmails(userId) });
});

app.put("/api/share-settings", requireUser, async (req, res) => {
  const parsed = shareSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  res.json(await store.updateDefaultShareEmails(userId, parsed.data.emails));
});

app.get("/api/lists", requireUser, async (req, res) => {
  const userId = (req as express.Request & { userId: number }).userId;
  res.json(await store.getListSummaries(userId));
});

app.post("/api/lists", requireUser, async (req, res) => {
  const parsed = createListSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  const id = await store.createList(userId, parsed.data.name);
  res.status(201).json({ id });
});

app.get("/api/lists/:listId", requireUser, async (req, res) => {
  const userId = (req as express.Request & { userId: number }).userId;
  try {
    res.json(await store.getListState(userId, Number(req.params.listId)));
  } catch {
    res.status(403).json({ error: "Forbidden" });
  }
});

app.delete("/api/lists/:listId", requireUser, async (req, res) => {
  const userId = (req as express.Request & { userId: number }).userId;
  try {
    await store.deleteList(userId, Number(req.params.listId));
    broadcastList(Number(req.params.listId));
    res.status(204).end();
  } catch {
    res.status(403).json({ error: "Forbidden" });
  }
});

app.get("/api/lists/:listId/item-suggestions", requireUser, async (req, res) => {
  const userId = (req as express.Request & { userId: number }).userId;
  try {
    res.json(await store.getItemSuggestions(userId, Number(req.params.listId), String(req.query.q ?? "")));
  } catch {
    res.status(403).json({ error: "Forbidden" });
  }
});

app.post("/api/lists/:listId/items", requireUser, async (req, res) => {
  const parsed = addItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  const listId = Number(req.params.listId);
  try {
    const itemId = await store.addListItem(userId, listId, parsed.data.name);
    broadcastList(listId);
    res.status(201).json({ id: itemId });
  } catch {
    res.status(403).json({ error: "Forbidden" });
  }
});

app.patch("/api/items/:itemId", requireUser, async (req, res) => {
  const parsed = updateItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  try {
    await store.updateItem(userId, Number(req.params.itemId), parsed.data);
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to update item" });
    return;
  }

  try {
    const listId = await store.getItemListId(Number(req.params.itemId));
    if (listId) {
      broadcastList(listId);
    }
  } catch {
    // best effort
  }
});

let store: AppStore;
let memCleanup: (() => Promise<void>) | null = null;

async function createAppStore() {
  if (process.env.USE_MEM_DB === "true") {
    const { newDb } = await import("pg-mem");
    const db = newDb();
    const adapter = db.adapters.createPg();
    const PgMemPool = adapter.Pool;
    const memPool = new PgMemPool();
    memCleanup = () => memPool.end();
    return new AppStore({ db: memPool as any });
  }
  return new AppStore({ connectionString: config.databaseUrl });
}

const storePromise = createAppStore().then((s) => {
  store = s;
  return s;
});

async function start() {
  await storePromise;
  await store.initialize();
  httpServer.listen(config.port, "0.0.0.0", () => {
    console.log(`server listening on ${config.port}`);
    if (process.env.USE_MEM_DB === "true") {
      console.log("using in-memory DB (USE_MEM_DB=true)");
    }
  });
}

void start().catch(async (error) => {
  console.error(error);
  if (memCleanup) {
    try { await memCleanup(); } catch {}
  }
  process.exit(1);
});
