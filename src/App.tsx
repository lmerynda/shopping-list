import { useEffect, useState } from "react";
import type { HouseholdState, SessionPayload, ShoppingListState, ShoppingListSummary } from "./lib/types";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:4000";
const WS_URL = API_URL.startsWith("https://")
  ? API_URL.replace("https://", "wss://")
  : API_URL.replace("http://", "ws://");
const STORAGE_KEY = "shopping-list-session-token";
const THEME_KEY = "shopping-list-theme";

type AuthStep = "request" | "verify";
type Theme = "light" | "dark";
type Route = { name: "home" } | { name: "list"; listId: number } | { name: "settings" };
type InvitePreview = {
  email: string;
  householdName: string;
};

// test

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

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const listMatch = hash.match(/^\/lists\/(\d+)$/);
  if (listMatch) {
    return { name: "list", listId: Number(listMatch[1]) };
  }
  if (hash === "/settings") {
    return { name: "settings" };
  }
  return { name: "home" };
}

function navigate(route: Route) {
  if (route.name === "home") {
    window.location.hash = "/";
  } else if (route.name === "settings") {
    window.location.hash = "/settings";
  } else {
    window.location.hash = `/lists/${route.listId}`;
  }
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
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [token, setToken] = useState<string | null>(() => getSavedToken());
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [lists, setLists] = useState<ShoppingListSummary[]>([]);
  const [listState, setListState] = useState<ShoppingListState | null>(null);
  const [pendingInviteCode, setPendingInviteCode] = useState(() => getInviteCodeFromUrl());
  const [invitePreview, setInvitePreview] = useState<InvitePreview | null>(null);
  const [invitePreviewLoaded, setInvitePreviewLoaded] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

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
        setError(null);
      })
      .catch((nextError) => {
        window.localStorage.removeItem(STORAGE_KEY);
        setToken(null);
        setError(nextError.message);
      });
  }, [token]);

  useEffect(() => {
    if (!token || !session) {
      return;
    }

    api<ShoppingListSummary[]>("/api/lists", undefined, token)
      .then((nextLists) => {
        setLists(nextLists);
        setError(null);
      })
      .catch((nextError) => setError(nextError.message));
  }, [token, session, refreshTick]);

  useEffect(() => {
    if (!token || route.name !== "list") {
      setListState(null);
      return;
    }

    api<ShoppingListState>(`/api/lists/${route.listId}`, undefined, token)
      .then((nextState) => {
        setListState(nextState);
        setError(null);
      })
      .catch((nextError) => {
        setError(nextError.message);
        navigate({ name: "home" });
      });
  }, [token, route, refreshTick]);

  useEffect(() => {
    if (!token || route.name !== "list") {
      return;
    }

    const socket = new WebSocket(`${WS_URL}/ws?token=${token}&listId=${route.listId}`);
    socket.addEventListener("message", () => {
      setRefreshTick((tick) => tick + 1);
    });
    return () => {
      socket.close();
    };
  }, [token, route]);

  useEffect(() => {
    if (!pendingInviteCode) {
      setInvitePreview(null);
      setInvitePreviewLoaded(false);
      return;
    }

    setInvitePreviewLoaded(false);
    api<InvitePreview>(`/api/invites/${pendingInviteCode}`)
      .then((preview) => {
        setInvitePreview(preview);
        setInvitePreviewLoaded(true);
        setError(null);
      })
      .catch((nextError) => {
        setInvitePreview(null);
        setInvitePreviewLoaded(true);
        setError(nextError.message);
      });
  }, [pendingInviteCode]);

  useEffect(() => {
    if (!token || !session || !pendingInviteCode || !invitePreviewLoaded || inviteBusy) {
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
        setPendingInviteCode("");
        setInvitePreview(null);
        setInvitePreviewLoaded(false);
        setError(null);
        setRefreshTick((tick) => tick + 1);
        window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      })
      .catch((nextError) => {
        setPendingInviteCode("");
        setInvitePreviewLoaded(false);
        setError(nextError.message);
      })
      .finally(() => setInviteBusy(false));
  }, [inviteBusy, invitePreview, invitePreviewLoaded, pendingInviteCode, session, token]);

  const hasMultipleHouseholds = (session?.households.length ?? 0) > 1;

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
                Fast weekly grocery planning with real-time sharing, focused lists, and no ad junk slipped into your
                groceries.
              </p>
              <div className="feature-pills">
                <span className="feature-pill">Live household sync</span>
                <span className="feature-pill">Multiple lists</span>
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
        <AppHeader
          session={session}
          theme={theme}
          onToggleTheme={() => setTheme(theme === "light" ? "dark" : "light")}
          onOpenSettings={() => navigate({ name: "settings" })}
          onSignOut={() => {
            window.localStorage.removeItem(STORAGE_KEY);
            setToken(null);
            setSession(null);
            setLists([]);
            setListState(null);
            navigate({ name: "home" });
          }}
        />

        {error ? <p className="error app-error">{error}</p> : null}

        {route.name === "home" ? (
          <ListsHome
            session={session}
            lists={lists}
            hasMultipleHouseholds={hasMultipleHouseholds}
            token={token}
            onOpenList={(listId) => navigate({ name: "list", listId })}
            onRefresh={() => setRefreshTick((tick) => tick + 1)}
            onSessionChange={setSession}
          />
        ) : null}

        {route.name === "list" ? (
          <ListDetail
            state={listState}
            token={token}
            onBack={() => navigate({ name: "home" })}
            onRefresh={() => setRefreshTick((tick) => tick + 1)}
          />
        ) : null}

        {route.name === "settings" ? (
          <SettingsView
            session={session}
            token={token}
            theme={theme}
            onToggleTheme={() => setTheme(theme === "light" ? "dark" : "light")}
            onBack={() => navigate({ name: "home" })}
            onSessionChange={(nextSession) => {
              setSession(nextSession);
              setRefreshTick((tick) => tick + 1);
            }}
            onRefresh={() => setRefreshTick((tick) => tick + 1)}
          />
        ) : null}
      </section>
    </main>
  );
}

function AppHeader(props: {
  session: SessionPayload;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  return (
    <header className="app-header">
      <button type="button" className="brand-button" onClick={() => navigate({ name: "home" })}>
        Shopping List
      </button>
      <div className="header-actions">
        <span className="signed-in">Signed in as {props.session.user.displayName}</span>
        <ThemeSwitch theme={props.theme} onToggle={props.onToggleTheme} />
        <button className="ghost-button" onClick={props.onOpenSettings}>
          Settings
        </button>
        <button className="ghost-button" onClick={props.onSignOut}>
          Sign out
        </button>
      </div>
    </header>
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

function ListsHome(props: {
  session: SessionPayload;
  lists: ShoppingListSummary[];
  hasMultipleHouseholds: boolean;
  token: string;
  onOpenList: (listId: number) => void;
  onRefresh: () => void;
  onSessionChange: (session: SessionPayload) => void;
}) {
  const [listName, setListName] = useState("");
  const [householdName, setHouseholdName] = useState("");
  const [householdId, setHouseholdId] = useState(() => props.session.households[0]?.id ?? 0);
  const totalActive = props.lists.reduce((sum, list) => sum + list.activeCount, 0);
  const totalCompleted = props.lists.reduce((sum, list) => sum + list.completedCount, 0);

  useEffect(() => {
    if (!props.session.households.some((household) => household.id === householdId)) {
      setHouseholdId(props.session.households[0]?.id ?? 0);
    }
  }, [householdId, props.session.households]);

  return (
    <div className="stack">
      <section className="hero compact-hero">
        <div className="hero-copy">
          <p className="eyebrow">Lists</p>
          <h1>Your lists</h1>
          <p className="lede">Pick the list you are shopping from now.</p>
        </div>
        <div className="hero-metrics">
          <div className="metric-card">
            <span className="metric-value">{totalActive}</span>
            <span className="metric-label">Left to buy</span>
          </div>
          <div className="metric-card">
            <span className="metric-value">{totalCompleted}</span>
            <span className="metric-label">Bought</span>
          </div>
        </div>
      </section>

      {props.session.households.length === 0 ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="section-label">Start</span>
              <h2>Create your household</h2>
            </div>
          </div>
          <div className="toolbar-grid">
            <input
              value={householdName}
              onChange={(event) => setHouseholdName(event.target.value)}
              placeholder="Our home"
              aria-label="New household"
            />
            <button
              onClick={async () => {
                if (!householdName.trim()) return;
                const nextSession = await api<SessionPayload>("/api/households", {
                  method: "POST",
                  body: JSON.stringify({ name: householdName }),
                }, props.token);
                setHouseholdName("");
                props.onSessionChange(nextSession);
                props.onRefresh();
              }}
            >
              Create household
            </button>
          </div>
        </section>
      ) : null}

      {props.session.households.length > 0 ? (
      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="section-label">Create</span>
            <h2>New list</h2>
          </div>
        </div>
        <div className="composer-grid">
          <input value={listName} onChange={(event) => setListName(event.target.value)} placeholder="Groceries" />
          {props.session.households.length > 1 ? (
            <select value={householdId} onChange={(event) => setHouseholdId(Number(event.target.value))}>
              {props.session.households.map((household) => (
                <option key={household.id} value={household.id}>
                  {household.name}
                </option>
              ))}
            </select>
          ) : null}
          <button
            onClick={async () => {
              if (!listName.trim() || !householdId) return;
              await api(`/api/households/${householdId}/lists`, {
                method: "POST",
                body: JSON.stringify({ name: listName }),
              }, props.token);
              setListName("");
              props.onRefresh();
            }}
          >
            Create list
          </button>
        </div>
      </section>
      ) : null}

      <section className="list-grid" aria-label="Shopping lists">
        {props.lists.length === 0 ? (
          <div className="panel empty-panel">
            <p className="empty-state">Create your first list to start shopping.</p>
          </div>
        ) : (
          props.lists.map((list) => (
            <button key={list.id} className="list-card" onClick={() => props.onOpenList(list.id)}>
              <span className="list-card-main">
                <strong>{list.name}</strong>
                {props.hasMultipleHouseholds ? <span>{list.householdName}</span> : null}
              </span>
              <span className="list-card-counts">
                <span>{list.activeCount} active</span>
                <span>{list.completedCount} bought</span>
              </span>
            </button>
          ))
        )}
      </section>
    </div>
  );
}

function ListDetail(props: {
  state: ShoppingListState | null;
  token: string;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [itemName, setItemName] = useState("");
  const [itemNote, setItemNote] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);

  if (!props.state) {
    return (
      <section className="panel empty-panel">
        <p className="empty-state">Loading list...</p>
      </section>
    );
  }

  return (
    <div className="stack">
      <section className="detail-header">
        <button className="text-button" onClick={props.onBack}>
          Back
        </button>
        <div>
          <span className="section-label">{props.state.list.householdName}</span>
          <h1>{props.state.list.name}</h1>
        </div>
        <span className="panel-badge">{props.state.activeItems.length} active</span>
      </section>

      <section className="panel composer-panel">
        <div className="composer-grid">
          <input value={itemName} onChange={(event) => setItemName(event.target.value)} placeholder="Milk" />
          <input value={itemNote} onChange={(event) => setItemNote(event.target.value)} placeholder="Optional note" />
          <button
            onClick={async () => {
              if (!itemName.trim()) return;
              await api(`/api/lists/${props.state!.list.id}/items`, {
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

      <section className="panel list-panel">
        <div className="panel-header">
          <div>
            <span className="section-label">Today</span>
            <h2>Active list</h2>
          </div>
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
        <button className="section-toggle" onClick={() => setShowCompleted((current) => !current)}>
          <span>Bought</span>
          <span>{props.state.completedItems.length}</span>
        </button>
        {showCompleted ? (
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
        ) : null}
      </section>
    </div>
  );
}

function SettingsView(props: {
  session: SessionPayload;
  token: string;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
  onSessionChange: (session: SessionPayload) => void;
  onRefresh: () => void;
}) {
  const [householdName, setHouseholdName] = useState("");
  const [selectedHouseholdId, setSelectedHouseholdId] = useState(() => props.session.households[0]?.id ?? 0);
  const [householdState, setHouseholdState] = useState<HouseholdState | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [devInviteCode, setDevInviteCode] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedHousehold = props.session.households.find((household) => household.id === selectedHouseholdId) ?? null;

  useEffect(() => {
    if (!props.session.households.some((household) => household.id === selectedHouseholdId)) {
      setSelectedHouseholdId(props.session.households[0]?.id ?? 0);
    }
  }, [props.session.households, selectedHouseholdId]);

  useEffect(() => {
    if (!selectedHouseholdId) {
      setHouseholdState(null);
      return;
    }

    api<HouseholdState>(`/api/households/${selectedHouseholdId}`, undefined, props.token)
      .then((nextState) => {
        setHouseholdState(nextState);
        setError(null);
      })
      .catch((nextError) => setError(nextError.message));
  }, [props.token, selectedHouseholdId, props.session]);

  return (
    <div className="stack">
      <section className="detail-header">
        <button className="text-button" onClick={props.onBack}>
          Back
        </button>
        <div>
          <span className="section-label">Manage</span>
          <h1>Settings</h1>
        </div>
      </section>

      <section className="panel settings-grid">
        <div className="settings-row">
          <div>
            <span className="section-label">Account</span>
            <h2>{props.session.user.displayName}</h2>
            <p className="lede">{props.session.user.email}</p>
          </div>
          <ThemeSwitch theme={props.theme} onToggle={props.onToggleTheme} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="section-label">Households</span>
            <h2>Spaces you belong to</h2>
          </div>
        </div>
        <div className="household-list">
          {props.session.households.map((household) => (
            <button
              key={household.id}
              className={household.id === selectedHouseholdId ? "household-row selected" : "household-row"}
              onClick={() => setSelectedHouseholdId(household.id)}
            >
              <span>{household.name}</span>
              <span className="status-pill pending">{household.role}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-grid settings-form">
          <input
            value={householdName}
            onChange={(event) => setHouseholdName(event.target.value)}
            placeholder="New household"
          />
          <button
            onClick={async () => {
              if (!householdName.trim()) return;
              const nextSession = await api<SessionPayload>("/api/households", {
                method: "POST",
                body: JSON.stringify({ name: householdName }),
              }, props.token);
              setHouseholdName("");
              props.onSessionChange(nextSession);
              setStatus("Household created.");
            }}
          >
            Create household
          </button>
        </div>
        {selectedHousehold ? (
          <div className="danger-row">
            <div>
              <strong>Leave {selectedHousehold.name}</strong>
              <p className="lede">You will lose access to its lists unless someone invites you again.</p>
            </div>
            <button
              className="danger-button"
              onClick={async () => {
                try {
                  const nextSession = await api<SessionPayload>(
                    `/api/households/${selectedHousehold.id}/members/me`,
                    { method: "DELETE" },
                    props.token,
                  );
                  props.onSessionChange(nextSession);
                  setStatus(`Left ${selectedHousehold.name}.`);
                  setError(null);
                } catch (nextError) {
                  setError(nextError instanceof Error ? nextError.message : "Unable to leave household");
                }
              }}
            >
              Leave household
            </button>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="section-label">Join</span>
            <h2>Accept invite</h2>
          </div>
        </div>
        <div className="toolbar-grid">
          <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="Invite code" />
          <button
            onClick={async () => {
              if (!inviteCode.trim()) return;
              try {
                const nextSession = await api<SessionPayload>("/api/invites/accept", {
                  method: "POST",
                  body: JSON.stringify({ code: inviteCode }),
                }, props.token);
                setInviteCode("");
                props.onSessionChange(nextSession);
                setStatus("Invite accepted.");
                setError(null);
              } catch (nextError) {
                setError(nextError instanceof Error ? nextError.message : "Unable to accept invite");
              }
            }}
          >
            Join household
          </button>
        </div>
      </section>

      {selectedHouseholdId ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <span className="section-label">Sharing</span>
              <h2>Invites</h2>
            </div>
          </div>
          <div className="toolbar-grid">
            <input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="family@example.com" />
            <button
              onClick={async () => {
                if (!inviteEmail.trim()) return;
                setStatus(null);
                setError(null);
                try {
                  const email = inviteEmail.trim();
                  const result = await api<{ ok: true; emailed: boolean; mailConfigured: boolean; devCode?: string }>(
                    `/api/households/${selectedHouseholdId}/invites`,
                    { method: "POST", body: JSON.stringify({ email }) },
                    props.token,
                  );
                  setDevInviteCode(result.devCode ?? null);
                  setStatus(result.emailed ? `Invite sent to ${email}.` : `Invite created for ${email}.`);
                  setInviteEmail("");
                  props.onRefresh();
                  const nextState = await api<HouseholdState>(`/api/households/${selectedHouseholdId}`, undefined, props.token);
                  setHouseholdState(nextState);
                } catch (nextError) {
                  setError(nextError instanceof Error ? nextError.message : "Unable to send invite");
                }
              }}
            >
              Send invite
            </button>
          </div>
          {devInviteCode ? (
            <p className="dev-hint" data-testid="dev-invite-code">
              Dev invite code: {devInviteCode}
            </p>
          ) : null}
          <ul className="invite-list">
            {(householdState?.invites ?? []).map((invite) => (
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
                        try {
                          await api(`/api/invites/${invite.id}`, { method: "DELETE" }, props.token);
                          setStatus(`Invite removed for ${invite.email}.`);
                          const nextState = await api<HouseholdState>(`/api/households/${selectedHouseholdId}`, undefined, props.token);
                          setHouseholdState(nextState);
                        } catch (nextError) {
                          setError(nextError instanceof Error ? nextError.message : "Unable to remove invite");
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
      ) : null}

      {status ? <p className="success">{status}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function ItemList(props: {
  items: ShoppingListState["activeItems"];
  categories: ShoppingListState["categories"];
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
            {item.note ? <p>{item.note}</p> : null}
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
