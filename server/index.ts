import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { isMailEnabled, sendInviteEmail, sendLoginCodeEmail } from "./mailer.js";
import { AppStore } from "./store.js";
import {
  acceptInviteSchema,
  addItemSchema,
  createHouseholdSchema,
  inviteSchema,
  requestCodeSchema,
  updateItemSchema,
  verifyCodeSchema,
} from "./schema.js";

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

app.use(express.json());

app.use((req, res, next) => {
  const requestOrigin = req.header("origin");
  const isAllowedOrigin =
    !requestOrigin ||
    requestOrigin === config.clientOrigin ||
    (config.clientOriginRegex ? config.clientOriginRegex.test(requestOrigin) : false);

  if (isAllowedOrigin && requestOrigin) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Vary", "Origin");
  } else if (!requestOrigin) {
    res.setHeader("Access-Control-Allow-Origin", config.clientOrigin);
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
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

type Client = { ws: import("ws").WebSocket; userId: number; householdId: number };
const clients = new Set<Client>();

function broadcastHousehold(householdId: number) {
  for (const client of clients) {
    if (client.householdId === householdId && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify({ type: "household-updated", householdId }));
    }
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const token = url.searchParams.get("token") ?? undefined;
  const householdId = Number(url.searchParams.get("householdId"));
  const userId = store.getUserIdFromToken(token);

  if (!userId || !householdId) {
    ws.close();
    return;
  }

  try {
    store.ensureMembership(userId, householdId);
  } catch {
    ws.close();
    return;
  }

  const client = { ws, userId, householdId };
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
  void store.resetForTests().then(() => {
    res.status(204).end();
  }).catch(() => {
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
    emailed = await sendLoginCodeEmail({
      email: parsed.data.email,
      code,
    });
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

app.get("/api/invites/:code", async (req, res) => {
  try {
    res.json(await store.getInvitePreview(req.params.code));
  } catch {
    res.status(404).json({ error: "Invite not found" });
  }
});

app.get("/api/session", requireUser, async (req, res) => {
  const userId = (req as express.Request & { userId: number }).userId;
  res.json(await store.getSessionPayload(userId));
});

app.post("/api/households", requireUser, async (req, res) => {
  const parsed = createHouseholdSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  res.status(201).json(await store.createHousehold(userId, parsed.data.name));
});

app.get("/api/households/:householdId", requireUser, async (req, res) => {
  const userId = (req as express.Request & { userId: number }).userId;
  try {
    res.json(await store.getHouseholdState(userId, Number(req.params.householdId)));
  } catch {
    res.status(403).json({ error: "Forbidden" });
  }
});

app.post("/api/households/:householdId/invites", requireUser, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  const householdId = Number(req.params.householdId);
  let household: { id: number; name: string } | null = null;
  let code: string;
  try {
    household = await store.getHousehold(userId, householdId);
    if (!household) {
      res.status(404).json({ error: "Household not found" });
      return;
    }
    code = await store.createInvite(userId, householdId, parsed.data.email);
  } catch {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  let emailed = false;
  try {
    emailed = await sendInviteEmail({
      email: parsed.data.email,
      code,
      householdName: household.name,
    });
  } catch (error) {
    console.error("Failed to send invite email", error);
    res.status(502).json({ error: "Invite created, but email delivery failed" });
    return;
  }

  broadcastHousehold(householdId);
  res.status(201).json({
    ok: true,
    emailed,
    mailConfigured: isMailEnabled(),
    devCode: process.env.NODE_ENV !== "production" ? code : undefined,
  });
});

app.post("/api/invites/accept", requireUser, async (req, res) => {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  try {
    const session = await store.acceptInvite(userId, parsed.data.code);
    res.json(session);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to accept invite" });
  }
});

app.delete("/api/invites/:inviteId", requireUser, async (req, res) => {
  const userId = (req as express.Request & { userId: number }).userId;
  try {
    const householdId = await store.deletePendingInvite(userId, Number(req.params.inviteId));
    broadcastHousehold(householdId);
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to remove invite" });
  }
});

app.post("/api/households/:householdId/items", requireUser, async (req, res) => {
  const parsed = addItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  const householdId = Number(req.params.householdId);
  try {
    const itemId = await store.addItem(userId, householdId, parsed.data.name, parsed.data.note);
    broadcastHousehold(householdId);
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
    const householdId = await store.getItemHouseholdId(Number(req.params.itemId));
    if (householdId) {
      broadcastHousehold(householdId);
    }
  } catch {
    // best effort
  }
});

const store = new AppStore({ connectionString: config.databaseUrl });

async function start() {
  await store.initialize();
  httpServer.listen(config.port, "0.0.0.0", () => {
    console.log(`server listening on ${config.port}`);
  });
}

void start().catch((error) => {
  console.error(error);
  process.exit(1);
});
