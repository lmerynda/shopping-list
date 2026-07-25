import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ItemSuggestion, SessionPayload, ShareSettings, ShoppingListState, ShoppingListSummary } from "./lib/types";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:4000";
const WS_URL = API_URL.startsWith("https://") ? API_URL.replace("https://", "wss://") : API_URL.replace("http://", "ws://");
const STORAGE_KEY = "shopping-list-session-token";
const THEME_KEY = "shopping-list-theme";

type AuthStep = "request" | "verify";
type Theme = "light" | "dark";
type Route = { name: "home" } | { name: "list"; listId: number } | { name: "settings" };
type IconName =
  | "add" | "arrowBack" | "check" | "chevronDown" | "close" | "delete" | "email"
  | "group" | "list" | "more" | "palette" | "person" | "refresh" | "settings"
  | "produce" | "dairy" | "meat" | "pantry" | "frozen" | "bakery" | "household" | "pharmacy";

function getSavedToken() {
  return window.localStorage.getItem(STORAGE_KEY);
}

function getInitialTheme(): Theme {
  const saved = window.localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const match = hash.match(/^\/lists\/(\d+)$/);
  if (match) return { name: "list", listId: Number(match[1]) };
  if (hash === "/settings") return { name: "settings" };
  return { name: "home" };
}

function navigate(route: Route) {
  window.location.hash = route.name === "home" ? "/" : route.name === "settings" ? "/settings" : `/lists/${route.listId}`;
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
  if (response.status === 204) return undefined as T;
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
    window.scrollTo({ top: 0 });
  }, [route]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  useEffect(() => {
    if (!token) return;
    setAutoOpenedOnlyList(false);
    api<SessionPayload>("/api/session", undefined, token).then((next) => {
      setSession(next);
      setError(null);
    }).catch((nextError) => {
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
    api<ShoppingListSummary[]>("/api/lists", undefined, token).then((next) => {
      setLists(next);
      setError(null);
    }).catch((nextError) => setError(nextError.message));
  }, [token, session, refreshTick]);
  useEffect(() => {
    if (!token || route.name !== "list") {
      setListState(null);
      return;
    }
    api<ShoppingListState>(`/api/lists/${route.listId}`, undefined, token).then((next) => {
      setListState(next);
      setError(null);
    }).catch((nextError) => {
      setError(nextError.message);
      navigate({ name: "home" });
    });
  }, [token, route, refreshTick]);
  useEffect(() => {
    if (!token || route.name !== "list") return;
    const socket = new WebSocket(`${WS_URL}/ws?token=${token}&listId=${route.listId}`);
    socket.addEventListener("message", () => setRefreshTick((tick) => tick + 1));
    return () => socket.close();
  }, [token, route]);

  const toggleTheme = () => setTheme(theme === "light" ? "dark" : "light");

  if (!token || !session) {
    return (
      <main className="auth-screen">
        <section className="auth-content">
          <div className="app-mark" aria-hidden="true"><Icon name="list" /></div>
          <div className="auth-heading">
            <h1>Grocery App</h1>
          </div>
          <AuthScreen onSignedIn={(nextToken, nextSession) => {
            window.localStorage.setItem(STORAGE_KEY, nextToken);
            setToken(nextToken);
            setSession(nextSession);
          }} />
          {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}
        </section>
      </main>
    );
  }

  const signOut = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setSession(null);
    setLists([]);
    setListState(null);
    navigate({ name: "home" });
  };

  return (
    <main className="app-viewport">
      <section className="app-frame">
        {error ? <StatusMessage kind="error" floating>{error}</StatusMessage> : null}
        {route.name === "home" ? (
          <ListsHome
            lists={lists}
            token={token}
            session={session}
            onOpenList={(listId) => navigate({ name: "list", listId })}
            onOpenSettings={() => navigate({ name: "settings" })}
            onRefresh={() => setRefreshTick((tick) => tick + 1)}
          />
        ) : null}
        {route.name === "list" ? (
          <ListDetail
            state={listState}
            userId={session.user.id}
            token={token}
            onBack={() => navigate({ name: "home" })}
            onOpenSettings={() => navigate({ name: "settings" })}
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
            onToggleTheme={toggleTheme}
            onBack={() => navigate({ name: "home" })}
            onSignOut={signOut}
            onSessionChange={setSession}
          />
        ) : null}
      </section>
    </main>
  );
}

function AuthScreen(props: { onSignedIn: (token: string, session: SessionPayload) => void }) {
  const isLocal = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  const [step, setStep] = useState<AuthStep>("request");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ ok: true; devCode?: string }>("/api/auth/request-code", {
        method: "POST", body: JSON.stringify({ email, displayName }),
      });
      setDevCode(result.devCode ?? null);
      setStep("verify");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to send code");
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ token: string; session: SessionPayload }>(
        isLocal ? "/api/test/login" : "/api/auth/verify",
        { method: "POST", body: JSON.stringify(isLocal ? { email, displayName } : { email, code }) },
      );
      props.onSignedIn(result.token, result.session);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to sign in");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={(event) => {
      event.preventDefault();
      void (isLocal || step === "verify" ? signIn() : requestCode());
    }}>
      {step === "request" ? (
        <>
          <TextField label="Display name" value={displayName} onChange={setDisplayName} placeholder="Alex" autoComplete="name" />
          <TextField label="Email" value={email} onChange={setEmail} placeholder="alex@example.com" type="email" autoComplete="email" />
          <button className="primary-button" disabled={busy || !email.trim() || !displayName.trim()}>
            {busy ? "Please wait…" : isLocal ? "Sign in" : "Send magic code"}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="back-link" onClick={() => setStep("request")}><Icon name="arrowBack" /> Change email</button>
          <p className="form-support">Enter the code sent to <strong>{email}</strong>.</p>
          <TextField label="Verification code" value={code} onChange={setCode} placeholder="ABC123" autoComplete="one-time-code" />
          {devCode ? <p className="dev-code" data-testid="dev-auth-code">Development code: <strong>{devCode}</strong></p> : null}
          <button className="primary-button" disabled={busy || !code.trim()}>{busy ? "Signing in…" : "Sign in"}</button>
        </>
      )}
      {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}
    </form>
  );
}

function ListsHome(props: {
  lists: ShoppingListSummary[];
  token: string;
  session: SessionPayload;
  onOpenList: (listId: number) => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [listName, setListName] = useState("");
  const [busy, setBusy] = useState(false);

  const createList = async () => {
    if (!listName.trim() || busy) return;
    setBusy(true);
    try {
      await api("/api/lists", { method: "POST", body: JSON.stringify({ name: listName.trim() }) }, props.token);
      setListName("");
      setCreating(false);
      props.onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen home-screen">
      <TopAppBar
        title="Groceries"
        subtitle={`${props.lists.reduce((sum, list) => sum + list.activeCount, 0)} items to buy`}
        actions={<button className="icon-button avatar-button" onClick={props.onOpenSettings} aria-label="Settings">{props.session.user.displayName.charAt(0).toUpperCase()}</button>}
      />
      <div className="screen-content list-overview">
        <div className="section-heading">
          <div><p className="overline">Your lists</p><h1>Ready to shop?</h1></div>
          <span className="count-badge">{props.lists.length}</span>
        </div>
        {props.lists.length === 0 ? (
          <div className="empty-state large-empty">
            <div className="empty-icon"><Icon name="list" /></div>
            <h2>No lists yet</h2>
            <p>Create a list and start adding what you need.</p>
          </div>
        ) : (
          <div className="list-cards" aria-label="Shopping lists">
            {props.lists.map((list) => (
              <button key={list.id} className="shopping-list-row" onClick={() => props.onOpenList(list.id)}>
                <span className="list-leading"><Icon name={list.shared ? "group" : "list"} /></span>
                <span className="list-row-copy">
                  <strong>{list.name}</strong>
                  <span>{list.shared ? `Shared by ${list.ownerName}` : "Private list"} · {list.completedCount} checked</span>
                </span>
                <span className="active-count">{list.activeCount}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="extended-fab" onClick={() => setCreating(true)}><Icon name="add" /> New list</button>
      <Dialog open={creating} title="Create a new list" onClose={() => setCreating(false)} initialFocus>
        <form onSubmit={(event) => { event.preventDefault(); void createList(); }}>
          <TextField label="List name" value={listName} onChange={setListName} placeholder="Groceries" autoComplete="off" />
          <div className="dialog-actions">
            <button type="button" className="text-action" onClick={() => setCreating(false)}>Cancel</button>
            <button className="filled-action" disabled={!listName.trim() || busy}>{busy ? "Creating…" : "Create list"}</button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function ListDetail(props: {
  state: ShoppingListState | null;
  userId: number;
  token: string;
  onBack: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onDeleted: () => void;
}) {
  const [itemName, setItemName] = useState("");
  const [suggestions, setSuggestions] = useState<ItemSuggestion[]>([]);
  const [adding, setAdding] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!props.state) {
      setSuggestions([]);
      return;
    }
    const timeout = window.setTimeout(() => {
      api<ItemSuggestion[]>(`/api/lists/${props.state!.list.id}/item-suggestions?q=${encodeURIComponent(itemName)}`, undefined, props.token)
        .then(setSuggestions).catch(() => setSuggestions([]));
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [itemName, props.state, props.token]);

  if (!props.state) {
    return <div className="screen loading-screen"><div className="loading-indicator" /><p>Loading your list…</p></div>;
  }

  const addItem = async (name: string) => {
    const nextName = name.trim();
    if (!nextName || adding) return;
    setAdding(true);
    setItemName("");
    setSuggestions([]);
    try {
      await api(`/api/lists/${props.state!.list.id}/items`, { method: "POST", body: JSON.stringify({ name: nextName }) }, props.token);
      props.onRefresh();
    } finally {
      setAdding(false);
    }
  };

  const isOwner = props.state.list.ownerId === props.userId;
  return (
    <div className="screen shopping-screen">
      <TopAppBar
        title={props.state.list.name}
        subtitle={props.state.list.ownerId === props.userId ? `${props.state.activeItems.length} items left` : `Shared by ${props.state.list.ownerName}`}
        navigation={<button className="icon-button" onClick={props.onBack} aria-label="Back"><Icon name="arrowBack" /></button>}
        actions={
          <div className="menu-anchor">
            <button className="icon-button" onClick={() => setMenuOpen(!menuOpen)} aria-label="More options" aria-expanded={menuOpen}><Icon name="more" /></button>
            {menuOpen ? (
              <>
                <button className="menu-scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />
                <div className="overflow-menu" role="menu">
                  <button role="menuitem" onClick={() => { setMenuOpen(false); props.onOpenSettings(); }}><Icon name="settings" /> Settings</button>
                  {isOwner ? <button className="danger-action" role="menuitem" onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}><Icon name="delete" /> Delete list</button> : null}
                </div>
              </>
            ) : null}
          </div>
        }
      />
      <section className="items-content list-panel" aria-label="Shopping list">
        <ItemList
          items={props.state.activeItems}
          actionLabel="Mark bought"
          onAction={async (itemId) => {
            await api(`/api/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ status: "completed" }) }, props.token);
            props.onRefresh();
          }}
        />
        {props.state.completedItems.length > 0 ? (
          <section className="completed-section">
            <button className="completed-toggle" aria-expanded={completedOpen} onClick={() => setCompletedOpen(!completedOpen)}>
              <span><Icon name="check" /> Checked <span className="checked-count">{props.state.completedItems.length}</span></span>
              <Icon name="chevronDown" />
            </button>
            {completedOpen ? (
              <ItemList
                items={props.state.completedItems}
                completed
                actionLabel="Re-add"
                onAction={async (itemId) => {
                  await api(`/api/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }, props.token);
                  props.onRefresh();
                }}
              />
            ) : null}
          </section>
        ) : null}
      </section>
      <section className="item-composer">
        {suggestions.length > 0 ? (
          <div className="suggestion-strip" aria-label="Item suggestions">
            {suggestions.map((suggestion) => (
              <button key={`${suggestion.source}-${suggestion.normalizedName}`} type="button" onClick={() => void addItem(suggestion.name)}>{suggestion.name}</button>
            ))}
          </div>
        ) : null}
        <form className="composer-bar" onSubmit={(event) => { event.preventDefault(); void addItem(itemName); }}>
          <Icon name="add" />
          <input value={itemName} onChange={(event) => setItemName(event.target.value)} placeholder="Add item" aria-label="Add item" autoComplete="off" />
          <button type="submit" className="composer-submit" disabled={adding || !itemName.trim()} aria-label="Add item"><Icon name="arrowBack" /></button>
        </form>
      </section>
      <Dialog open={confirmDelete} title={`Delete “${props.state.list.name}”?`} onClose={() => setConfirmDelete(false)}>
        <p className="dialog-copy">This list and every item in it will be permanently deleted.</p>
        <div className="dialog-actions">
          <button className="text-action" onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button className="danger-filled" onClick={async () => {
            await api(`/api/lists/${props.state!.list.id}`, { method: "DELETE" }, props.token);
            props.onDeleted();
          }}>Delete</button>
        </div>
      </Dialog>
    </div>
  );
}

function SettingsView(props: {
  session: SessionPayload;
  token: string;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
  onSignOut: () => void;
  onSessionChange: (session: SessionPayload) => void;
}) {
  const [shareEmail, setShareEmail] = useState("");
  const [shareEmails, setShareEmails] = useState(() => props.session.defaultShareEmails);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ShareSettings>("/api/share-settings", undefined, props.token).then((settings) => {
      setShareEmails(settings.emails);
      setError(null);
    }).catch((nextError) => setError(nextError.message));
  }, [props.token]);

  const saveShares = async (emails: string[]) => {
    const settings = await api<ShareSettings>("/api/share-settings", { method: "PUT", body: JSON.stringify({ emails }) }, props.token);
    setShareEmails(settings.emails);
    props.onSessionChange({ ...props.session, defaultShareEmails: settings.emails });
    setStatus("Sharing defaults saved");
    setError(null);
  };

  return (
    <div className="screen settings-screen">
      <TopAppBar title="Settings" navigation={<button className="icon-button" onClick={props.onBack} aria-label="Back"><Icon name="arrowBack" /></button>} />
      <div className="settings-content">
        <section className="settings-group">
          <p className="group-label">Account</p>
          <div className="account-row">
            <span className="account-avatar">{props.session.user.displayName.charAt(0).toUpperCase()}</span>
            <span><strong>{props.session.user.displayName}</strong><small>{props.session.user.email}</small></span>
          </div>
        </section>
        <section className="settings-group">
          <p className="group-label">Appearance</p>
          <div className="setting-row">
            <span className="setting-icon"><Icon name="palette" /></span>
            <span className="setting-copy"><strong>Dark theme</strong><small>Use darker colors throughout the app</small></span>
            <button className={`switch ${props.theme === "dark" ? "selected" : ""}`} onClick={props.onToggleTheme} role="switch" aria-checked={props.theme === "dark"} aria-label="Dark theme"><span /></button>
          </div>
        </section>
        <section className="settings-group sharing-settings">
          <p className="group-label">Default sharing</p>
          <p className="group-support">People added here automatically receive access to new lists.</p>
          <form className="email-composer" onSubmit={async (event) => {
            event.preventDefault();
            if (!shareEmail.trim()) return;
            try {
              await saveShares([...shareEmails, shareEmail.trim()]);
              setShareEmail("");
            } catch (nextError) {
              setError(nextError instanceof Error ? nextError.message : "Unable to save sharing defaults");
            }
          }}>
            <TextField label="Email address" value={shareEmail} onChange={setShareEmail} placeholder="family@example.com" type="email" autoComplete="email" ariaLabel="Default share email" />
            <button className="filled-action" disabled={!shareEmail.trim()}><Icon name="add" /> Add email</button>
          </form>
          <div className="email-list">
            {shareEmails.length === 0 ? <p className="inline-empty">New lists are private by default.</p> : shareEmails.map((email) => (
              <div className="email-row" key={email}>
                <span className="setting-icon"><Icon name="email" /></span>
                <span>{email}</span>
                <button className="icon-button" aria-label={`Remove ${email}`} onClick={async () => {
                  try {
                    await saveShares(shareEmails.filter((next) => next !== email));
                  } catch (nextError) {
                    setError(nextError instanceof Error ? nextError.message : "Unable to remove email");
                  }
                }}><Icon name="close" /></button>
              </div>
            ))}
          </div>
        </section>
        <button className="sign-out-button" onClick={props.onSignOut}>Sign out</button>
        {status ? <StatusMessage kind="success">{status}</StatusMessage> : null}
        {error ? <StatusMessage kind="error">{error}</StatusMessage> : null}
      </div>
    </div>
  );
}

function ItemList(props: {
  items: ShoppingListState["activeItems"];
  actionLabel: string;
  completed?: boolean;
  onAction: (itemId: number) => Promise<void>;
}) {
  if (props.items.length === 0) {
    return (
      <div className="empty-state list-empty">
        <div className="empty-icon"><Icon name="check" /></div>
        <h2>All clear</h2>
        <p>Nothing here yet.</p>
      </div>
    );
  }
  return (
    <ul className={`item-list ${props.completed ? "completed-list" : ""}`}>
      {props.items.map((item) => (
        <li className="item-row" key={item.id}>
          <span className="category-icon" aria-label={item.categoryLabel} title={item.categoryLabel}><Icon name={categoryIcon(item.categoryKey)} /></span>
          <strong className="item-name">{item.name}</strong>
          <button className="check-button" onClick={() => props.onAction(item.id)} aria-label={props.actionLabel}>
            {props.completed ? <Icon name="refresh" /> : <Icon name="check" />}
          </button>
        </li>
      ))}
    </ul>
  );
}

function TopAppBar(props: { title: string; subtitle?: string; navigation?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="top-app-bar">
      <div className="top-navigation">{props.navigation}</div>
      <div className="top-title"><h1>{props.title}</h1>{props.subtitle ? <span>{props.subtitle}</span> : null}</div>
      <div className="top-actions">{props.actions}</div>
    </header>
  );
}

function TextField(props: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string;
  type?: string; autoComplete?: string; ariaLabel?: string;
}) {
  const id = useId();
  return (
    <label className="text-field" htmlFor={id}>
      <span>{props.label}</span>
      <input id={id} type={props.type} value={props.value} onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder} autoComplete={props.autoComplete} aria-label={props.ariaLabel} />
    </label>
  );
}

function Dialog(props: { open: boolean; title: string; onClose: () => void; children: ReactNode; initialFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
    focusable()[props.initialFocus ? 0 : focusable().length - 1]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [props.open, props.onClose, props.initialFocus]);
  if (!props.open) return null;
  return (
    <div className="dialog-layer">
      <button className="dialog-scrim" aria-label="Close dialog" onClick={props.onClose} />
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref}>
        <h2 id="dialog-title">{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

function StatusMessage(props: { kind: "error" | "success"; children: ReactNode; floating?: boolean }) {
  return <p className={`status-message ${props.kind} ${props.floating ? "floating-status" : ""}`}>{props.children}</p>;
}

function categoryIcon(key: string): IconName {
  return (["produce", "dairy", "meat", "pantry", "frozen", "bakery", "household", "pharmacy"] as IconName[]).includes(key as IconName)
    ? key as IconName : "list";
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    add: <path d="M12 5v14M5 12h14" />, arrowBack: <path d="m15 18-6-6 6-6" />, check: <path d="m5 12 4 4L19 6" />,
    chevronDown: <path d="m6 9 6 6 6-6" />, close: <path d="M6 6l12 12M18 6 6 18" />, delete: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" /></>,
    email: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
    group: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c0-4 2-6 6-6s6 2 6 6M15 15c3.5 0 5 1.7 5 5" /></>,
    list: <><path d="M8 6h12M8 12h12M8 18h12" /><circle cx="4" cy="6" r=".7" fill="currentColor" /><circle cx="4" cy="12" r=".7" fill="currentColor" /><circle cx="4" cy="18" r=".7" fill="currentColor" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>,
    palette: <><path d="M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h4a5 5 0 0 0 5-5c0-3-4-5-9-5Z" /><circle cx="7.5" cy="9" r=".8" fill="currentColor" /><circle cx="10" cy="6" r=".8" fill="currentColor" /><circle cx="14" cy="6" r=".8" fill="currentColor" /></>,
    person: <><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-5 3.5-7 8-7s7.2 2 8 7" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 0-2 5" /></>, settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>,
    produce: <><path d="M12 21c-5-3-7-8-5-13 5 0 9 3 10 8" /><path d="M12 21c0-7 3-12 8-15 1 7-2 12-8 15Z" /></>,
    dairy: <><path d="m8 3 8 0 1 4 2 3v11H5V10l2-3 1-4Z" /><path d="M7 7h10M12 10v11" /></>,
    meat: <><path d="M6 18c-4-3-2-10 3-13 4-3 10 1 10 6 0 6-8 10-13 7Z" /><circle cx="13.5" cy="10.5" r="2.5" /></>,
    pantry: <><path d="M6 7h12l-1 14H7L6 7ZM8 3h8l2 4H6l2-4Z" /><path d="M10 12h4" /></>,
    frozen: <><path d="M12 2v20M4 6l16 12M20 6 4 18M9 4l3 3 3-3M3 10l4 1-1 4M18 9l-1 4 4 1M9 20l3-3 3 3" /></>,
    bakery: <><path d="M6 20c-3-1-3-5 0-7-2-3 1-6 4-5 1-4 7-4 8 0 3 1 3 5 1 7 2 3-1 5-4 5H6Z" /><path d="m9 12 2-2M13 14l2-2M9 17l2-2" /></>,
    household: <><path d="M8 7h8l2 14H6L8 7ZM10 7V4h4v3" /><path d="M9 12h6M10 16h4" /></>,
    pharmacy: <><rect x="4" y="7" width="16" height="13" rx="2" /><path d="M9 7V4h6v3M12 10v7M8.5 13.5h7" /></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
