import { useEffect, useState } from "react";
import type { ItemSuggestion, SessionPayload, ShareSettings, ShoppingListState, ShoppingListSummary } from "./lib/types";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:4000";
const WS_URL = API_URL.startsWith("https://")
  ? API_URL.replace("https://", "wss://")
  : API_URL.replace("http://", "ws://");
const STORAGE_KEY = "shopping-list-session-token";
const THEME_KEY = "shopping-list-theme";

type AuthStep = "request" | "verify";
type Theme = "light" | "dark";
type Route = { name: "home" } | { name: "list"; listId: number } | { name: "settings" };

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
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [autoOpenedOnlyList, setAutoOpenedOnlyList] = useState(false);

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
    if (!token) return;
    setAutoOpenedOnlyList(false);

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
    if (route.name === "home" && lists.length === 1 && !autoOpenedOnlyList) {
      setAutoOpenedOnlyList(true);
      navigate({ name: "list", listId: lists[0].id });
    }
  }, [autoOpenedOnlyList, lists, route]);

  useEffect(() => {
    if (!token || !session) return;

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
    if (!token || route.name !== "list") return;

    const socket = new WebSocket(`${WS_URL}/ws?token=${token}&listId=${route.listId}`);
    socket.addEventListener("message", () => {
      setRefreshTick((tick) => tick + 1);
    });
    return () => {
      socket.close();
    };
  }, [token, route]);

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
                <span className="feature-pill">Live list sync</span>
                <span className="feature-pill">Default sharing</span>
                <span className="feature-pill">History for repeats</span>
              </div>
            </div>
            <div className="auth-panel">
              <AuthScreen
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
            lists={lists}
            token={token}
            onOpenList={(listId) => navigate({ name: "list", listId })}
            onRefresh={() => setRefreshTick((tick) => tick + 1)}
          />
        ) : null}

        {route.name === "list" ? (
          <ListDetail
            state={listState}
            userId={session.user.id}
            token={token}
            onBack={() => navigate({ name: "home" })}
            onRefresh={() => setRefreshTick((tick) => tick + 1)}
            onDeleted={() => {
              navigate({ name: "home" });
              setRefreshTick((tick) => tick + 1);
            }}
          />
        ) : null}

        {route.name === "settings" ? (
          <SettingsView
            session={session}
            token={token}
            theme={theme}
            onToggleTheme={() => setTheme(theme === "light" ? "dark" : "light")}
            onBack={() => navigate({ name: "home" })}
            onSessionChange={setSession}
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
  lists: ShoppingListSummary[];
  token: string;
  onOpenList: (listId: number) => void;
  onRefresh: () => void;
}) {
  const [listName, setListName] = useState("");
  const totalActive = props.lists.reduce((sum, list) => sum + list.activeCount, 0);
  const totalCompleted = props.lists.reduce((sum, list) => sum + list.completedCount, 0);

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

      <section className="panel">
        <div className="panel-header">
          <div>
            <span className="section-label">Create</span>
            <h2>New list</h2>
          </div>
        </div>
        <div className="composer-grid">
          <input value={listName} onChange={(event) => setListName(event.target.value)} placeholder="Groceries" />
          <button
            onClick={async () => {
              if (!listName.trim()) return;
              await api("/api/lists", {
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
                {list.shared ? <span>Shared by {list.ownerName}</span> : null}
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
  userId: number;
  token: string;
  onBack: () => void;
  onRefresh: () => void;
  onDeleted: () => void;
}) {
  const [itemName, setItemName] = useState("");
  const [suggestions, setSuggestions] = useState<ItemSuggestion[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!props.state) {
      setSuggestions([]);
      return;
    }

    const timeout = window.setTimeout(() => {
      api<ItemSuggestion[]>(
        `/api/lists/${props.state!.list.id}/item-suggestions?q=${encodeURIComponent(itemName)}`,
        undefined,
        props.token,
      )
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [itemName, props.state, props.token]);

  if (!props.state) {
    return (
      <section className="panel empty-panel">
        <p className="empty-state">Loading list...</p>
      </section>
    );
  }

  const addItem = async (name: string) => {
    const nextName = name.trim();
    if (!nextName || adding) return;
    setAdding(true);
    setItemName("");
    setSuggestions([]);
    try {
      await api(`/api/lists/${props.state!.list.id}/items`, {
        method: "POST",
        body: JSON.stringify({ name: nextName }),
      }, props.token);
      props.onRefresh();
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="stack">
      <section className="detail-header">
        <button className="text-button" onClick={props.onBack}>
          Back
        </button>
        <div>
          <span className="section-label">{props.state.list.ownerName}</span>
          <h1>{props.state.list.name}</h1>
        </div>
        <div className="detail-actions">
          <span className="panel-badge">{props.state.activeItems.length} active</span>
          {props.state.list.ownerId === props.userId ? (
            <button
              className="danger-button"
              onClick={async () => {
                await api(`/api/lists/${props.state!.list.id}`, { method: "DELETE" }, props.token);
                props.onDeleted();
              }}
            >
              Delete list
            </button>
          ) : null}
        </div>
      </section>

      <section className="add-panel">
        <form
          className="add-bar"
          onSubmit={(event) => {
            event.preventDefault();
            void addItem(itemName);
          }}
        >
          <input
            value={itemName}
            onChange={(event) => setItemName(event.target.value)}
            placeholder="Milk"
            aria-label="Add item"
            autoComplete="off"
          />
          <button type="submit" disabled={adding || !itemName.trim()}>
            Add item
          </button>
        </form>
        {suggestions.length > 0 ? (
          <div className="suggestion-strip" aria-label="Item suggestions">
            {suggestions.map((suggestion) => (
              <button
                key={`${suggestion.source}-${suggestion.normalizedName}`}
                type="button"
                className="suggestion-chip"
                onClick={() => void addItem(suggestion.name)}
              >
                {suggestion.name}
              </button>
            ))}
          </div>
        ) : null}
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
          actionIcon="✓"
          onAction={async (itemId) => {
            await api(`/api/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ status: "completed" }) }, props.token);
            props.onRefresh();
          }}
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
            actionIcon="+"
            onAction={async (itemId) => {
              await api(`/api/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }, props.token);
              props.onRefresh();
            }}
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
}) {
  const [shareEmail, setShareEmail] = useState("");
  const [shareEmails, setShareEmails] = useState(() => props.session.defaultShareEmails);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ShareSettings>("/api/share-settings", undefined, props.token)
      .then((settings) => {
        setShareEmails(settings.emails);
        setError(null);
      })
      .catch((nextError) => setError(nextError.message));
  }, [props.token]);

  const saveShares = async (emails: string[]) => {
    const settings = await api<ShareSettings>(
      "/api/share-settings",
      { method: "PUT", body: JSON.stringify({ emails }) },
      props.token,
    );
    setShareEmails(settings.emails);
    props.onSessionChange({ ...props.session, defaultShareEmails: settings.emails });
    setStatus("Sharing defaults saved.");
    setError(null);
  };

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
            <span className="section-label">Sharing</span>
            <h2>Default list sharing</h2>
          </div>
        </div>
        <div className="toolbar-grid settings-form">
          <input
            value={shareEmail}
            onChange={(event) => setShareEmail(event.target.value)}
            placeholder="family@example.com"
            aria-label="Default share email"
          />
          <button
            onClick={async () => {
              if (!shareEmail.trim()) return;
              try {
                await saveShares([...shareEmails, shareEmail.trim()]);
                setShareEmail("");
              } catch (nextError) {
                setError(nextError instanceof Error ? nextError.message : "Unable to save sharing defaults");
              }
            }}
          >
            Add email
          </button>
        </div>
        <ul className="share-list">
          {shareEmails.length === 0 ? (
            <li className="empty-state">New lists are private by default.</li>
          ) : (
            shareEmails.map((email) => (
              <li key={email} className="share-row">
                <span>{email}</span>
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      await saveShares(shareEmails.filter((nextEmail) => nextEmail !== email));
                    } catch (nextError) {
                      setError(nextError instanceof Error ? nextError.message : "Unable to remove email");
                    }
                  }}
                >
                  Remove
                </button>
              </li>
            ))
          )}
        </ul>
      </section>

      {status ? <p className="success">{status}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function ItemList(props: {
  items: ShoppingListState["activeItems"];
  actionLabel: string;
  actionIcon: string;
  onAction: (itemId: number) => Promise<void>;
}) {
  if (props.items.length === 0) {
    return <p className="empty-state">Nothing here yet.</p>;
  }

  return (
    <ul className="item-list">
      {props.items.map((item) => (
        <li className="item-row" key={item.id}>
          <span className="item-category-icon" aria-label={item.categoryLabel} title={item.categoryLabel}>
            {getCategoryIcon(item.categoryKey)}
          </span>
          <strong className="item-name">{item.name}</strong>
          <button className="item-check-button" onClick={() => props.onAction(item.id)} aria-label={props.actionLabel}>
            <span aria-hidden="true">{props.actionIcon}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function getCategoryIcon(categoryKey: string) {
  switch (categoryKey) {
    case "produce":
      return "🥬";
    case "dairy":
      return "🥛";
    case "meat":
      return "🥩";
    case "pantry":
      return "🥫";
    case "frozen":
      return "❄";
    case "bakery":
      return "🍞";
    case "household":
      return "🧼";
    case "pharmacy":
      return "+";
    default:
      return "•";
  }
}
