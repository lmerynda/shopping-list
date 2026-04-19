import { useEffect, useMemo, useState } from "react";
import type { HouseholdState, SessionPayload } from "./lib/types";

const API_URL = "http://127.0.0.1:4000";
const STORAGE_KEY = "shopping-list-session-token";

type AuthStep = "request" | "verify";

function getSavedToken() {
  return window.localStorage.getItem(STORAGE_KEY);
}

async function api<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "Request failed");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function App() {
  const [token, setToken] = useState<string | null>(() => getSavedToken());
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [selectedHouseholdId, setSelectedHouseholdId] = useState<number | null>(null);
  const [state, setState] = useState<HouseholdState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!token) {
      return;
    }

    api<SessionPayload>("/api/session", undefined, token)
      .then((nextSession) => {
        setSession(nextSession);
        setSelectedHouseholdId((current) => current ?? nextSession.households[0]?.id ?? null);
      })
      .catch((nextError) => {
        window.localStorage.removeItem(STORAGE_KEY);
        setToken(null);
        setError(nextError.message);
      });
  }, [token]);

  useEffect(() => {
    if (!token || !selectedHouseholdId) {
      return;
    }

    api<HouseholdState>(`/api/households/${selectedHouseholdId}`, undefined, token)
      .then((nextState) => {
        setState(nextState);
      })
      .catch((nextError) => setError(nextError.message));
  }, [token, selectedHouseholdId, refreshTick]);

  useEffect(() => {
    if (!token || !selectedHouseholdId) {
      return;
    }

    const socket = new WebSocket(`${API_URL.replace("http", "ws")}/ws?token=${token}&householdId=${selectedHouseholdId}`);
    socket.addEventListener("message", () => {
      setRefreshTick((tick) => tick + 1);
    });
    return () => {
      socket.close();
    };
  }, [token, selectedHouseholdId]);

  const selectedHousehold = useMemo(
    () => session?.households.find((household) => household.id === selectedHouseholdId) ?? null,
    [selectedHouseholdId, session],
  );

  if (!token || !session) {
    return (
      <main className="shell">
        <section className="card auth-card">
          <h1>Shopping List</h1>
          <p className="lede">Shared household shopping without ads or junk in your list.</p>
          <AuthScreen
            onSignedIn={(nextToken, nextSession) => {
              window.localStorage.setItem(STORAGE_KEY, nextToken);
              setToken(nextToken);
              setSession(nextSession);
              setSelectedHouseholdId(nextSession.households[0]?.id ?? null);
            }}
          />
          {error ? <p className="error">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="card">
        <header className="app-header">
          <div>
            <h1>Shopping List</h1>
            <p className="lede">Signed in as {session.user.displayName}</p>
          </div>
          <button
            className="ghost-button"
            onClick={() => {
              window.localStorage.removeItem(STORAGE_KEY);
              setToken(null);
              setSession(null);
              setState(null);
            }}
          >
            Sign out
          </button>
        </header>

        <HouseholdToolbar
          session={session}
          selectedHouseholdId={selectedHouseholdId}
          onSelect={setSelectedHouseholdId}
          onCreate={async (name) => {
            const nextSession = await api<SessionPayload>("/api/households", {
              method: "POST",
              body: JSON.stringify({ name }),
            }, token);
            setSession(nextSession);
            setSelectedHouseholdId(nextSession.households.at(-1)?.id ?? null);
          }}
          onAcceptInvite={async (code) => {
            const nextSession = await api<SessionPayload>("/api/invites/accept", {
              method: "POST",
              body: JSON.stringify({ code }),
            }, token);
            setSession(nextSession);
            setSelectedHouseholdId(nextSession.households.at(-1)?.id ?? null);
          }}
        />

        {!selectedHousehold || !state ? (
          <EmptyState />
        ) : (
          <HouseholdView household={selectedHousehold} state={state} token={token} onRefresh={() => setRefreshTick((tick) => tick + 1)} />
        )}
      </section>
    </main>
  );
}

function EmptyState() {
  return <p className="empty-state">Create a household or accept an invite to start building a shared list.</p>;
}

function AuthScreen(props: { onSignedIn: (token: string, session: SessionPayload) => void }) {
  const [step, setStep] = useState<AuthStep>("request");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="stack">
      {step === "request" ? (
        <>
          <label>
            Display name
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Alex" />
          </label>
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="alex@example.com" />
          </label>
          <button
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const result = await api<{ ok: true; devCode?: string }>("/api/auth/request-code", {
                  method: "POST",
                  body: JSON.stringify({ email, displayName }),
                });
                setDevCode(result.devCode ?? null);
                setStep("verify");
              } catch (nextError) {
                setError(nextError instanceof Error ? nextError.message : "Unable to send code");
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            Send magic code
          </button>
        </>
      ) : (
        <>
          <label>
            Verification code
            <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="ABC123" />
          </label>
          {devCode ? (
            <p className="dev-hint" data-testid="dev-auth-code">
              Dev code: {devCode}
            </p>
          ) : null}
          <button
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const result = await api<{ token: string; session: SessionPayload }>("/api/auth/verify", {
                  method: "POST",
                  body: JSON.stringify({ email, code }),
                });
                props.onSignedIn(result.token, result.session);
              } catch (nextError) {
                setError(nextError instanceof Error ? nextError.message : "Unable to sign in");
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            Sign in
          </button>
          <button className="text-button" onClick={() => setStep("request")}>
            Start over
          </button>
        </>
      )}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function HouseholdToolbar(props: {
  session: SessionPayload;
  selectedHouseholdId: number | null;
  onSelect: (householdId: number) => void;
  onCreate: (name: string) => Promise<void>;
  onAcceptInvite: (code: string) => Promise<void>;
}) {
  const [householdName, setHouseholdName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  return (
    <section className="toolbar">
      <div className="toolbar-row">
        <label className="compact">
          Household
          <select value={props.selectedHouseholdId ?? ""} onChange={(event) => props.onSelect(Number(event.target.value))}>
            {props.session.households.map((household) => (
              <option key={household.id} value={household.id}>
                {household.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="toolbar-grid">
        <label className="compact">
          New household
          <input
            value={householdName}
            onChange={(event) => setHouseholdName(event.target.value)}
            placeholder="Our home"
          />
        </label>
        <button
          onClick={async () => {
            if (!householdName.trim()) return;
            await props.onCreate(householdName.trim());
            setHouseholdName("");
          }}
        >
          Create
        </button>
        <label className="compact">
          Invite code
          <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="Use family invite code" />
        </label>
        <button
          onClick={async () => {
            if (!inviteCode.trim()) return;
            await props.onAcceptInvite(inviteCode.trim());
            setInviteCode("");
          }}
        >
          Join
        </button>
      </div>
    </section>
  );
}

function HouseholdView(props: {
  household: SessionPayload["households"][number];
  state: HouseholdState;
  token: string;
  onRefresh: () => void;
}) {
  const [itemName, setItemName] = useState("");
  const [itemNote, setItemNote] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteCode, setInviteCode] = useState<string | null>(null);

  return (
    <div className="stack">
      <section className="hero">
        <div>
          <p className="eyebrow">{props.household.role}</p>
          <h2>{props.household.name}</h2>
          <p className="lede">Focus on what is left to buy. Completed items stay tucked away until you need them again.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Add item</h3>
        </div>
        <div className="toolbar-grid">
          <input value={itemName} onChange={(event) => setItemName(event.target.value)} placeholder="Milk" />
          <input value={itemNote} onChange={(event) => setItemNote(event.target.value)} placeholder="Optional note" />
          <button
            onClick={async () => {
              if (!itemName.trim()) return;
              await api(`/api/households/${props.household.id}/items`, {
                method: "POST",
                body: JSON.stringify({ name: itemName, note: itemNote }),
              }, props.token);
              setItemName("");
              setItemNote("");
              props.onRefresh();
            }}
          >
            Add
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Active list</h3>
          <span>{props.state.activeItems.length} items</span>
        </div>
        <ItemList
          items={props.state.activeItems}
          actionLabel="Mark bought"
          onAction={async (itemId) => {
            await api(`/api/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ status: "completed" }) }, props.token);
            props.onRefresh();
          }}
          onRecategorize={async (itemId, categoryKey) => {
            await api(`/api/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ categoryKey }) }, props.token);
            props.onRefresh();
          }}
          categories={props.state.categories}
        />
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Completed</h3>
          <span>{props.state.completedItems.length} hidden</span>
        </div>
        <ItemList
          items={props.state.completedItems}
          actionLabel="Re-add"
          onAction={async (itemId) => {
            await api(`/api/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }, props.token);
            props.onRefresh();
          }}
          onRecategorize={async (itemId, categoryKey) => {
            await api(`/api/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ categoryKey }) }, props.token);
            props.onRefresh();
          }}
          categories={props.state.categories}
        />
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Invites</h3>
        </div>
        <div className="toolbar-grid">
          <input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="family@example.com" />
          <button
            onClick={async () => {
              if (!inviteEmail.trim()) return;
              const result = await api<{ ok: true; devCode?: string }>(
                `/api/households/${props.household.id}/invites`,
                { method: "POST", body: JSON.stringify({ email: inviteEmail }) },
                props.token,
              );
              setInviteCode(result.devCode ?? null);
              setInviteEmail("");
              props.onRefresh();
            }}
          >
            Send invite
          </button>
        </div>
        {inviteCode ? (
          <p className="dev-hint" data-testid="dev-invite-code">
            Dev invite code: {inviteCode}
          </p>
        ) : null}
        <ul className="invite-list">
          {props.state.invites.map((invite) => (
            <li key={invite.id}>
              <span>{invite.email}</span>
              <span>{invite.acceptedAt ? "Joined" : "Pending"}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ItemList(props: {
  items: HouseholdState["activeItems"];
  categories: HouseholdState["categories"];
  actionLabel: string;
  onAction: (itemId: number) => Promise<void>;
  onRecategorize: (itemId: number, categoryKey: string) => Promise<void>;
}) {
  if (props.items.length === 0) {
    return <p className="empty-state">Nothing here yet.</p>;
  }

  return (
    <ul className="item-list">
      {props.items.map((item) => (
        <li className="item-row" key={item.id}>
          <div>
            <strong>{item.name}</strong>
            <p>{item.note || item.categoryLabel}</p>
          </div>
          <div className="item-actions">
            <select value={item.categoryKey} onChange={(event) => props.onRecategorize(item.id, event.target.value)}>
              {props.categories.map((category) => (
                <option key={category.key} value={category.key}>
                  {category.label}
                </option>
              ))}
            </select>
            <button onClick={() => props.onAction(item.id)}>{props.actionLabel}</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
