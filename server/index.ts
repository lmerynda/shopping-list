import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
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

const port = Number(process.env.PORT ?? 4000);
const dbPath = process.env.DB_PATH ?? "./data/app.sqlite";
const store = new AppStore(dbPath);

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CLIENT_ORIGIN ?? "http://127.0.0.1:4173");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
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
  store.resetForTests();
  res.status(204).end();
});

app.post("/api/auth/request-code", (req, res) => {
  const parsed = requestCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const code = store.requestMagicCode(parsed.data.email, parsed.data.displayName);
  res.json({
    ok: true,
    devCode: process.env.NODE_ENV !== "production" ? code : undefined,
  });
});

app.post("/api/auth/verify", (req, res) => {
  const parsed = verifyCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const session = store.verifyMagicCode(parsed.data.email, parsed.data.code);
  if (!session) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }
  res.json(session);
});

app.get("/api/session", requireUser, (req, res) => {
  const userId = (req as express.Request & { userId: number }).userId;
  res.json(store.getSessionPayload(userId));
});

app.post("/api/households", requireUser, (req, res) => {
  const parsed = createHouseholdSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  res.status(201).json(store.createHousehold(userId, parsed.data.name));
});

app.get("/api/households/:householdId", requireUser, (req, res) => {
  const userId = (req as express.Request & { userId: number }).userId;
  try {
    res.json(store.getHouseholdState(userId, Number(req.params.householdId)));
  } catch {
    res.status(403).json({ error: "Forbidden" });
  }
});

app.post("/api/households/:householdId/invites", requireUser, (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  const householdId = Number(req.params.householdId);
  try {
    const code = store.createInvite(userId, householdId, parsed.data.email);
    broadcastHousehold(householdId);
    res.status(201).json({
      ok: true,
      devCode: process.env.NODE_ENV !== "production" ? code : undefined,
    });
  } catch {
    res.status(403).json({ error: "Forbidden" });
  }
});

app.post("/api/invites/accept", requireUser, (req, res) => {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  try {
    const session = store.acceptInvite(userId, parsed.data.code);
    res.json(session);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to accept invite" });
  }
});

app.post("/api/households/:householdId/items", requireUser, (req, res) => {
  const parsed = addItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  const householdId = Number(req.params.householdId);
  try {
    const itemId = store.addItem(userId, householdId, parsed.data.name, parsed.data.note);
    broadcastHousehold(householdId);
    res.status(201).json({ id: itemId });
  } catch {
    res.status(403).json({ error: "Forbidden" });
  }
});

app.patch("/api/items/:itemId", requireUser, (req, res) => {
  const parsed = updateItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const userId = (req as express.Request & { userId: number }).userId;
  try {
    store.updateItem(userId, Number(req.params.itemId), parsed.data);
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to update item" });
    return;
  }

  try {
    const itemState = store.db
      .prepare("SELECT household_id as householdId FROM items WHERE id = ?")
      .get(Number(req.params.itemId)) as { householdId: number };
    broadcastHousehold(itemState.householdId);
  } catch {
    // best effort
  }
});

httpServer.listen(port, "127.0.0.1", () => {
  console.log(`server listening on ${port}`);
});
