import { useEffect, useMemo, useState } from "react";
import type { HouseholdState, SessionPayload } from "./lib/types";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:4000";
const WS_URL = API_URL.startsWith("https://")
  ? API_URL.replace("https://", "wss://")
  : API_URL.replace("http://", "ws://");
const STORAGE_KEY = "shopping-list-session-token";
const THEME_KEY = "shopping-list-theme";

type AuthStep = "request" | "verify";
type Theme = "light" | "dark";
type InvitePreview = {
  email: string;
  householdName: string;
};

function getSavedToken() {
  return window.localStorage.getItem(STORAGE_KEY);
}

function getInitialTheme(): Theme {
  const savedTheme = window.localStorage.getItem(THEME_KEY);
  if (savedTheme === "light" || savedTheme === "dark") {
    return savedTheme;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInviteCodeFromUrl() {
  return new URLSearchParams(window.location.search).get("invite") ?? "";
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
  const [pendingInviteCode, setPendingInviteCode] = useState(() => getInviteCodeFromUrl());
  const [invitePreview, setInvitePreview] = useState<InvitePreview | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

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
    if (!pendingInviteCode) {
      setInvitePreview(null);
      return;
    }

    api<InvitePreview>(`/api/invites/${pendingInviteCode}`)
      .then((preview) => {
        setInvitePreview(preview);
        setError(null);
      })
      .catch((nextError) => {
        setInvitePreview(null);
        setError(nextError.message);
      });
  }, [pendingInviteCode]);

  useEffect(() => {
    if (!token || !session || !pendingInviteCode || inviteBusy) {
      return;
    }
    if (invitePreview && session.user.email !== invitePreview.email) {
      setError(`This invite is for ${invitePreview.email}. Sign out and use that email to join.`);
      return;
    }

    setInviteBusy(true);
    api<SessionPayload>("/api/invites/accept", {
      method: "POST",
      body: JSON.stringify({ code: pendingInviteCode }),
    }, token)
      .then((nextSession) => {
        setSession(nextSession);
        setSelectedHouseholdId(nextSession.households.at(-1)?.id ?? null);
        setPendingInviteCode("");
        setInvitePreview(null);
        setError(null);
        window.history.replaceState(null, "", window.location.pathname);
      })
      .catch((nextError) => {
        setPendingInviteCode("");
        setError(nextError.message);
      })
      .finally(() => setInviteBusy(false));
  }, [inviteBusy, invitePreview, pendingInviteCode, session, token]);

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

    const socket = new WebSocket(`${WS_URL}/ws?token=${token}&householdId=${selectedHouseholdId}`);
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
        <section className="card auth-card elevated-card">
          <header className="marketing-header">
            <span className="kicker">Shared grocery planning</span>
            <ThemeSwitch theme={theme} onToggle={() => setTheme(theme === "light" ? "dark" : "light")} />
          </header>
          <div className="auth-layout">
            <div className="intro-copy">
              <h1>Shopping List</h1>
              <p className="lede">
                Fast weekly grocery planning with real-time sharing, hidden completed items, and no ad junk slipped into
                your list.
              </p>
              <div className="feature-pills">
                <span className="feature-pill">Live household sync</span>
                <span className="feature-pill">Category-sorted items</span>
                <span className="feature-pill">History for repeats</span>
              </div>
            </div>
            <div className="auth-panel">
              <AuthScreen
                initialEmail={invitePreview?.email ?? ""}
                inviteHouseholdName={invitePreview?.householdName ?? null}
                onSignedIn={(nextToken, nextSession) => {
                  window.localStorage.setItem(STORAGE_KEY, nextToken);
                  setToken(nextToken);
                  setSession(nextSession);
                  setSelectedHouseholdId(nextSession.households[0]?.id ?? null);
                }}
              />
              {error ? <p className="error">{error}</p> : null}
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="card app-card">
        <header className="app-header">
          <div>
            <span className="kicker">Shopping flow</span>
            <h1>Shopping List</h1>
            <p className="lede">Signed in as {session.user.displayName}</p>
          </div>
          <div className="header-actions">
            <ThemeSwitch theme={theme} onToggle={() => setTheme(theme === "light" ? "dark" : "light")} />
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
          </div>
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

function ThemeSwitch(props: { theme: Theme; onToggle: () => void }) {
  return (
    <button type="button" className="theme-toggle" onClick={props.onToggle} aria-label="Toggle theme">
      <span className={props.theme === "light" ? "theme-chip active" : "theme-chip"}>White</span>
      <span className={props.theme === "dark" ? "theme-chip active" : "theme-chip"}>Black</span>
    </button>
  );
}

function EmptyState() {
  return (
    <section className="panel empty-panel">
      <p className="empty-state">Create a household or accept an invite to start building a shared list.</p>
    </section>
  );
}

function AuthScreen(props: {
  initialEmail: string;
  inviteHouseholdName: string | null;
  onSignedIn: (token: string, session: SessionPayload) => void;
}) {
  const [step, setStep] = useState<AuthStep>("request");
  const [email, setEmail] = useState(props.initialEmail);
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.initialEmail) {
      setEmail(props.initialEmail);
    }
  }, [props.initialEmail]);

  return (
    <div className="stack">
      {props.inviteHouseholdName ? (
        <p className="success">Sign in as {props.initialEmail} to join {props.inviteHouseholdName}.</p>
      ) : null}
      {step === "request" ? (
        <>
          <label className="field">
            Display name
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Alex" />
          </label>
          <label className="field">
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
          <label className="field">
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
}) {
  const [householdName, setHouseholdName] = useState("");
  return (
    <section className="toolbar">
      <div className="toolbar-header">
        <div>
          <span className="section-label">Households</span>
          <p className="section-copy">Switch homes or create a new one.</p>
        </div>
      </div>
      <div className="toolbar-row">
        <label className="compact field">
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
        <label className="compact field">
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
          Create home
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
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  return (
    <div className="stack">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">{props.household.role}</p>
          <h2>{props.household.name}</h2>
          <p className="lede">Focus on what is left to buy. Completed items stay tucked away until you need them again.</p>
        </div>
        <div className="hero-metrics">
          <div className="metric-card">
            <span className="metric-value">{props.state.activeItems.length}</span>
            <span className="metric-label">Left to buy</span>
          </div>
          <div className="metric-card">
            <span className="metric-value">{props.state.completedItems.length}</span>
            <span className="metric-label">Bought</span>
          </div>
        </div>
      </section>

      <section className="panel composer-panel">
        <div className="panel-header">
          <div>
            <span className="section-label">Capture things quickly</span>
            <h3>Add item</h3>
          </div>
        </div>
        <div className="composer-grid">
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
            Add item
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="section-label">Today</span>
            <h3>Active list</h3>
          </div>
          <span className="panel-badge">{props.state.activeItems.length} items</span>
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
          <div>
            <span className="section-label">History</span>
            <h3>Completed</h3>
          </div>
          <span className="panel-badge">{props.state.completedItems.length} hidden</span>
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
          <div>
            <span className="section-label">Sharing</span>
            <h3>Invites</h3>
          </div>
        </div>
        <div className="toolbar-grid">
          <input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="family@example.com" />
          <button
            onClick={async () => {
              if (!inviteEmail.trim()) return;
              setInviteStatus(null);
              setInviteError(null);
              try {
                const email = inviteEmail.trim();
                const result = await api<{ ok: true; emailed: boolean; mailConfigured: boolean; devCode?: string }>(
                  `/api/households/${props.household.id}/invites`,
                  { method: "POST", body: JSON.stringify({ email }) },
                  props.token,
                );
                setInviteCode(result.devCode ?? null);
                setInviteStatus(result.emailed ? `Invite sent to ${email}.` : `Invite created for ${email}.`);
                setInviteEmail("");
                props.onRefresh();
              } catch (error) {
                setInviteError(error instanceof Error ? error.message : "Unable to send invite");
              }
            }}
          >
            Send invite
          </button>
        </div>
        {inviteStatus ? <p className="success">{inviteStatus}</p> : null}
        {inviteError ? <p className="error">{inviteError}</p> : null}
        {inviteCode ? (
          <p className="dev-hint" data-testid="dev-invite-code">
            Dev invite code: {inviteCode}
          </p>
        ) : null}
        <ul className="invite-list">
          {props.state.invites.map((invite) => (
            <li key={invite.id} className="invite-row">
              <span>{invite.email}</span>
              <div className="invite-actions">
                <span className={invite.acceptedAt ? "status-pill accepted" : "status-pill pending"}>
                  {invite.acceptedAt ? "Joined" : "Pending"}
                </span>
                {!invite.acceptedAt ? (
                  <button
                    className="text-button"
                    onClick={async () => {
                      setInviteStatus(null);
                      setInviteError(null);
                      try {
                        await api(`/api/invites/${invite.id}`, { method: "DELETE" }, props.token);
                        setInviteStatus(`Invite removed for ${invite.email}.`);
                        props.onRefresh();
                      } catch (error) {
                        setInviteError(error instanceof Error ? error.message : "Unable to remove invite");
                      }
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
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
          <div className="item-copy">
            <div className="item-title-row">
              <strong>{item.name}</strong>
              <span className="category-pill">{item.categoryLabel}</span>
            </div>
            <p>{item.note || "No note"}</p>
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
