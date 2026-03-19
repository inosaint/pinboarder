import { FormEvent, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { Stronghold } from "@tauri-apps/plugin-stronghold";
import "./App.css";

type Bookmark = {
  href: string;
  href_norm: string;
  title: string;
  tags: string;
  time_remote?: string | null;
  source: string;
};

type SyncStatus = {
  pending_count: number;
  last_sync_epoch?: number | null;
  last_error?: string | null;
};

type BookmarkPage = {
  items: Bookmark[];
  has_more: boolean;
};

type OpenUrlEvent = { url: string };

const STRONGHOLD_CLIENT_NAME = "pinboarder";
const STRONGHOLD_TOKEN_KEY = "pinboard_api_token";
const STRONGHOLD_PASSWORD = "pinboarder-vault-v1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _storePromise: Promise<{ stronghold: Stronghold; store: any }> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getStore(): Promise<{ stronghold: Stronghold; store: any }> {
  if (!_storePromise) {
    console.log("[pinboarder-stronghold] getStore: initializing vault (argon2 will run once)");
    _storePromise = (async () => {
      const vaultPath = await join(await appLocalDataDir(), "pinboarder.vault.hold");
      console.log("[pinboarder-stronghold] vault path:", vaultPath);
      const stronghold = await Stronghold.load(vaultPath, STRONGHOLD_PASSWORD);
      console.log("[pinboarder-stronghold] Stronghold.load completed");
      let client;
      try {
        client = await stronghold.loadClient(STRONGHOLD_CLIENT_NAME);
        console.log("[pinboarder-stronghold] loadClient succeeded");
      } catch {
        console.log("[pinboarder-stronghold] loadClient failed, creating new client");
        client = await stronghold.createClient(STRONGHOLD_CLIENT_NAME);
        console.log("[pinboarder-stronghold] createClient succeeded");
      }
      return { stronghold, store: client.getStore() };
    })();
    _storePromise.catch((err) => {
      console.error("[pinboarder-stronghold] vault init failed:", err);
      _storePromise = null; // allow retry on next call
    });
  } else {
    console.log("[pinboarder-stronghold] getStore: reusing cached vault");
  }
  return _storePromise;
}

async function readStoredToken(): Promise<string | null> {
  try {
    console.log("[pinboarder-stronghold] readStoredToken start");
    const { store } = await getStore();
    const raw = await store.get(STRONGHOLD_TOKEN_KEY);
    const token = raw ? new TextDecoder().decode(new Uint8Array(raw)).trim() : null;
    console.log("[pinboarder-stronghold] readStoredToken result:", token ? "found" : "not found");
    if (token) return token;
  } catch (err) {
    console.error("[pinboarder-stronghold] readStoredToken error (trying fallback):", err);
  }
  // Fallback: check localStorage (used when Stronghold fails)
  const fallback = window.localStorage.getItem("pinboarder_token_fallback");
  if (fallback) console.log("[pinboarder-stronghold] readStoredToken: using localStorage fallback");
  return fallback?.trim() || null;
}

async function writeStoredToken(token: string): Promise<void> {
  console.log("[pinboarder-stronghold] writeStoredToken start");
  const { stronghold, store } = await getStore();
  await store.insert(STRONGHOLD_TOKEN_KEY, Array.from(new TextEncoder().encode(token)));
  await stronghold.save();
  window.localStorage.removeItem("pinboarder_token_fallback"); // clear fallback once Stronghold succeeds
  console.log("[pinboarder-stronghold] writeStoredToken saved");
}

async function clearStoredToken(): Promise<void> {
  window.localStorage.removeItem("pinboarder_token_fallback");
  // Do NOT reset _storePromise — vault stays open, we just remove the key
  try {
    console.log("[pinboarder-stronghold] clearStoredToken start");
    const { stronghold, store } = await getStore();
    await store.remove(STRONGHOLD_TOKEN_KEY);
    await stronghold.save();
    console.log("[pinboarder-stronghold] clearStoredToken saved");
  } catch (err) {
    console.error("[pinboarder-stronghold] clearStoredToken error (ignored):", err);
  }
}

function extractDomain(urlText: string): string {
  try {
    const u = urlText.includes("://") ? urlText : `https://${urlText}`;
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return urlText.toLowerCase();
  }
}

function normalizeUrl(urlText: string): string {
  return urlText.includes("://") ? urlText : `https://${urlText}`;
}

function canOpenExternalUrl(urlText: string): boolean {
  try {
    const parsed = new URL(urlText);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatElapsedSync(secondsAgo: number): string {
  if (secondsAgo < 60) return "just now";
  const units = [
    { seconds: 60 * 60 * 24 * 365, label: "year" },
    { seconds: 60 * 60 * 24 * 30, label: "month" },
    { seconds: 60 * 60 * 24 * 7, label: "week" },
    { seconds: 60 * 60 * 24, label: "day" },
    { seconds: 60 * 60, label: "hour" },
    { seconds: 60, label: "minute" },
  ];
  for (const unit of units) {
    if (secondsAgo >= unit.seconds) {
      const value = Math.floor(secondsAgo / unit.seconds);
      return `${value} ${unit.label}${value === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

function syncLog(message: string, extra?: unknown) {
  if (extra !== undefined) {
    console.log(`[pinboarder-sync-ui] ${message}`, extra);
    return;
  }
  console.log(`[pinboarder-sync-ui] ${message}`);
}

function LoadingDots() {
  return (
    <span className="loading-dots" aria-hidden="true">
      <span className="loading-dot" />
      <span className="loading-dot" />
      <span className="loading-dot" />
    </span>
  );
}

function BookmarkRow({
  bookmark,
  onDelete,
  onEdit,
  animationDelay,
}: {
  bookmark: Bookmark;
  onDelete: (href: string) => Promise<void>;
  onEdit: (bookmark: Bookmark) => void;
  animationDelay?: number;
}) {
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ bottom: number; right: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  async function handleDelete() {
    setDeleting(true);
    setMenuOpen(false);
    try {
      await onDelete(bookmark.href);
    } catch {
      setDeleting(false);
    }
  }

  function handleEdit() {
    setMenuOpen(false);
    onEdit(bookmark);
  }

  function handleCopyUrl() {
    navigator.clipboard.writeText(bookmark.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div
      role="link"
      tabIndex={0}
      className={`bookmark-row${deleting ? " bookmark-row-deleting" : ""}`}
      style={animationDelay !== undefined ? { animationDelay: `${animationDelay}ms` } : undefined}
      onClick={() => {
        if (!deleting && canOpenExternalUrl(bookmark.href)) {
          openUrl(bookmark.href);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !deleting && canOpenExternalUrl(bookmark.href)) {
          openUrl(bookmark.href);
        }
      }}
    >
      <div className="bm-text">
        <span className="bm-title">
          {bookmark.title || extractDomain(bookmark.href)}
        </span>
        <span className="bm-domain">{extractDomain(bookmark.href)}</span>
      </div>
      <div className="bm-right">
        <div
          className="row-menu-wrap"
          ref={menuRef}
          data-open={menuOpen ? "true" : "false"}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            ref={btnRef}
            className="bm-menu-btn"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!deleting) {
                if (!menuOpen && btnRef.current) {
                  const rect = btnRef.current.getBoundingClientRect();
                  const right = window.innerWidth - rect.right;
                  // Always open above the button — avoids bottom-clipping for any row
                  setMenuPos({ bottom: window.innerHeight - rect.top + 4, right });
                }
                setMenuOpen((v) => !v);
              }
            }}
            disabled={deleting}
            title="Bookmark actions"
          >
            {deleting ? "…" : copied ? "✓" : "•••"}
          </button>
          {menuOpen && menuPos && (
            <div
              className="bm-row-menu"
              style={{ position: "fixed", ...menuPos }}
            >
              <button className="bm-row-menu-item" onClick={handleEdit}>
                Edit
              </button>
              <button className="bm-row-menu-item" onClick={handleCopyUrl}>
                Copy
              </button>
              <button
                className="bm-row-menu-item destructive"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleDelete();
                }}
                disabled={deleting}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const PAGE_SIZE = 25;

function App() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const bookmarkOffsetRef = useRef(PAGE_SIZE);
  const [hasMoreBookmarks, setHasMoreBookmarks] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [userTags, setUserTags] = useState<string[]>([]);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Setup form
  const [tokenInput, setTokenInput] = useState("");
  const [isSubmittingToken, setIsSubmittingToken] = useState(false);
  const [tokenLinkClicked, setTokenLinkClicked] = useState(false);

  // Add / edit form
  const [addUrl, setAddUrl] = useState("");
  const [addTitle, setAddTitle] = useState("");
  const [addTags, setAddTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagSuggestionsOpen, setTagSuggestionsOpen] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addStatus, setAddStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [isFetchingMeta, setIsFetchingMeta] = useState(false);
  const [editingHref, setEditingHref] = useState<string | null>(null);
  const metaFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaFetchGen = useRef(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  const hasBookmarks = bookmarks.length > 0;

  const syncInfo = useMemo(() => {
    if (isSyncing) return { label: "syncing", tone: "syncing" as const };
    if (status?.last_error) return { label: "error", tone: "error" as const };
    if (!status?.last_sync_epoch) return { label: "never", tone: "idle" as const };
    const secondsAgo = Math.max(0, Math.floor(Date.now() / 1000 - status.last_sync_epoch));
    return {
      label: formatElapsedSync(secondsAgo),
      tone: "ready" as const,
    };
  }, [isSyncing, status]);

  async function loadState() {
    syncLog("loadState start");
    const [page, syncStatus, tokenPresent] = await Promise.all([
      invoke<BookmarkPage>("get_recent_bookmarks_page", { limit: PAGE_SIZE, offset: 0 }),
      invoke<SyncStatus>("get_sync_status"),
      invoke<boolean>("has_api_token"),
    ]);
    setBookmarks(page.items);
    setHasMoreBookmarks(page.has_more);
    bookmarkOffsetRef.current = page.items.length;
    setStatus(syncStatus);
    setHasToken(tokenPresent);
    syncLog("loadState done", {
      items: page.items.length,
      hasMore: page.has_more,
      tokenPresent,
      syncStatus,
    });
  }

  async function loadMore() {
    if (isLoadingMore) return;
    syncLog("loadMore start", { offset: bookmarkOffsetRef.current });
    setIsLoadingMore(true);
    try {
      const currentOffset = bookmarkOffsetRef.current;
      const page = await invoke<BookmarkPage>("get_recent_bookmarks_page", {
        limit: PAGE_SIZE,
        offset: currentOffset,
      });
      setBookmarks((prev) => {
        const seen = new Set(prev.map((bm) => bm.href_norm));
        const nextPage = page.items.filter((bm) => !seen.has(bm.href_norm));
        return nextPage.length > 0 ? [...prev, ...nextPage] : prev;
      });
      setHasMoreBookmarks(page.has_more);
      bookmarkOffsetRef.current = currentOffset + page.items.length;
      syncLog("loadMore done", {
        fetched: page.items.length,
        hasMore: page.has_more,
        nextOffset: bookmarkOffsetRef.current,
      });
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function handleSetToken(e: FormEvent) {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setIsSubmittingToken(true);
    try {
      const token = tokenInput.trim();
      // Backend first — instant, no vault overhead — UI transitions immediately
      await invoke("set_api_token", { token });
      syncLog("set_api_token completed");
      setHasToken(true);
      setTokenInput("");
      // Vault write is fire-and-forget — never blocks the UI
      writeStoredToken(token).catch((err) => {
        console.error("[pinboarder-stronghold] background writeStoredToken failed, using localStorage fallback:", err);
        window.localStorage.setItem("pinboarder_token_fallback", token);
      });
      // Hydrate UI and sync in background; don't block setup transition.
      loadState().catch(console.error);
      setIsSyncing(true);
      syncLog("sync_now after token set start");
      invoke("sync_now")
        .then(() => {
          syncLog("sync_now after token set success");
          return loadState();
        })
        .catch((err) => {
          syncLog("sync_now after token set failed", err);
          console.error(err);
        })
        .finally(() => setIsSyncing(false));
    } finally {
      setIsSubmittingToken(false);
    }
  }

  const fetchMetaForUrl = useCallback((url: string) => {
    if (metaFetchTimer.current) clearTimeout(metaFetchTimer.current);
    const normalized = url.includes("://") ? url : `https://${url}`;
    try { new URL(normalized); } catch { return; } // not a valid URL yet
    const gen = ++metaFetchGen.current;
    metaFetchTimer.current = setTimeout(async () => {
      setIsFetchingMeta(true);
      try {
        const meta = await invoke<{ title: string; tags: string[] }>("fetch_page_meta", { url: normalized });
        if (gen !== metaFetchGen.current) return; // form was submitted/cleared, discard
        if (meta.title) setAddTitle(meta.title);
        if (meta.tags.length > 0) setAddTags(meta.tags);
      } catch {
        // silently ignore — user can fill in manually
      } finally {
        if (gen === metaFetchGen.current) setIsFetchingMeta(false);
      }
    }, 700);
  }, []);

  function handleEditBookmark(bookmark: Bookmark) {
    setAddUrl(bookmark.href);
    setAddTitle(bookmark.title);
    setAddTags(bookmark.tags.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean));
    setTagInput("");
    setEditingHref(bookmark.href);
    setAddStatus("idle");
    setTimeout(() => urlInputRef.current?.focus(), 50);
  }

  async function handleAddBookmark(e: FormEvent) {
    e.preventDefault();
    if (!addUrl.trim()) return;
    setIsAdding(true);
    setAddStatus("saving");
    if (metaFetchTimer.current) clearTimeout(metaFetchTimer.current);
    metaFetchGen.current++; // invalidate any in-flight fetch_page_meta
    setIsFetchingMeta(false);
    try {
      const newUrl = normalizeUrl(addUrl.trim());
      // If editing and the URL changed, delete the old bookmark first
      if (editingHref && editingHref !== newUrl) {
        await invoke("delete_bookmark", { href: editingHref });
      }
      await invoke("quick_add_bookmark", {
        url: newUrl,
        title: addTitle.trim() || extractDomain(addUrl.trim()),
        tags: addTags.join(", "),
      });
      setAddUrl("");
      setAddTitle("");
      setAddTags([]);
      setTagInput("");
      setEditingHref(null);
      await loadState();
      setAddStatus("saved");
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setAddStatus("idle"), 700);
    } catch {
      setAddStatus("idle");
    } finally {
      setIsAdding(false);
    }
  }

  async function handleSync() {
    setMenuOpen(false);
    setIsSyncing(true);
    syncLog("manual sync_now start");
    try {
      await invoke("sync_now");
      syncLog("manual sync_now success");
      invoke<string[]>("get_user_tags").then(setUserTags).catch(() => {});
    } catch (err) {
      syncLog("manual sync_now failed", err);
      console.error("sync_now failed", err);
    } finally {
      await loadState().catch(console.error);
      setIsSyncing(false);
      syncLog("manual sync_now done");
    }
  }

  async function handleResetToken() {
    setMenuOpen(false);
    // Fire vault clear in background — never block UI state reset
    clearStoredToken().catch((err) =>
      console.error("[pinboarder-stronghold] clearStoredToken background error:", err)
    );
    await invoke("clear_api_token");
    setHasToken(false);
    setBookmarks([]);
    setHasMoreBookmarks(false);
    setStatus(null);
    setAddUrl("");
    setAddTitle("");
    setAddTags([]);
    setTagInput("");
    setTagSuggestionsOpen(false);
    setAddStatus("idle");
    setEditingHref(null);
    setIsAdding(false);
    setIsFetchingMeta(false);
  }

  useEffect(() => {
    let active = true;
    (async () => {
      const token = await readStoredToken();
      syncLog("startup readStoredToken", { hasToken: !!token });
      if (active && token) {
        await invoke("set_api_token", { token });
        syncLog("startup set_api_token from local store success");
        invoke<string[]>("get_user_tags").then(setUserTags).catch(() => {});
      }
      if (active) {
        await loadState();
        // Always attempt a sync on app load when token exists.
        const has = await invoke<boolean>("has_api_token").catch(() => false);
        if (has) {
          setIsSyncing(true);
          syncLog("startup sync_now start");
          invoke("sync_now")
            .catch((err) => {
              syncLog("startup sync_now failed", err);
              console.error("startup sync_now failed", err);
            })
            .finally(() => {
              loadState().catch(console.error);
              invoke<string[]>("get_user_tags").then(setUserTags).catch(() => {});
              if (active) setIsSyncing(false);
              syncLog("startup sync_now done");
            });
        }
      }
    })().catch(console.error);
    const openUnlisten = listen<OpenUrlEvent>("open-url", (e) => {
      if (canOpenExternalUrl(e.payload.url)) {
        openUrl(e.payload.url);
      }
    });
    const recentUnlisten = listen("recent-updated", () => {
      syncLog("event recent-updated received");
      return loadState();
    });
    return () => {
      active = false;
      openUnlisten.then((f) => f());
      recentUnlisten.then((f) => f());
    };
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div className="panel-root">
    <div className="panel-nub" />
    <div className="app">
      {/* ── Header ── */}
      <header className="app-header">
        <span className="app-title">
          Pinboarder
          <span className="app-version">v{__APP_VERSION__}</span>
        </span>
        {hasToken && (
          <div className="header-actions">
            <div
              className={`sync-badge sync-badge-${syncInfo.tone}`}
              title="Sync status"
            >
              <span className="sync-dot" />
              <span className="sync-label">{syncInfo.label}</span>
            </div>
            <div className="menu-wrap" ref={menuRef}>
              <button
                className="icon-btn"
                onClick={() => setMenuOpen((v) => !v)}
                title="Options"
              >
                <span className="dots">•••</span>
              </button>
              {menuOpen && (
                <div className="dropdown">
                  <button
                    className="dropdown-item"
                    onClick={handleSync}
                    disabled={isSyncing}
                  >
                    {isSyncing ? "Syncing…" : "Sync now"}
                  </button>
                  <button
                    className="dropdown-item destructive"
                    onClick={handleResetToken}
                  >
                    Reset API Token
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      {/* ── Body ── */}
      {!hasToken ? (
        /* Setup state */
        <div className="setup-view">
          <h2 className="setup-title">Connect Pinboard</h2>
          <p className="setup-desc">
            Paste your API token to start syncing bookmarks.
          </p>
          <form className="setup-form" onSubmit={handleSetToken}>
            <input
              className="setup-input"
              placeholder="username:TOKEN"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.currentTarget.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="none"
              autoFocus
              disabled={isSubmittingToken}
            />
            <button
              className="btn-primary"
              type="submit"
              disabled={isSubmittingToken || !tokenInput.trim()}
            >
              {isSubmittingToken ? <>Connecting<LoadingDots /></> : "Connect"}
            </button>
          </form>
          <button
            className={`setup-link${tokenLinkClicked ? " setup-link-visited" : ""}`}
            onClick={() => {
              setTokenLinkClicked(true);
              openUrl("https://pinboard.in/settings/password");
            }}
          >
            Find your token at pinboard.in →
          </button>
        </div>
      ) : (
        <div className="main-content">
          {/* Add bookmark form */}
          <form className="add-form" onSubmit={handleAddBookmark}>
            <input
              ref={urlInputRef}
              className="add-input"
              placeholder="Paste URL..."
              value={addUrl}
              onChange={(e) => {
                const val = e.currentTarget.value;
                setAddUrl(val);
                if (!val.trim()) {
                  if (metaFetchTimer.current) clearTimeout(metaFetchTimer.current);
                  metaFetchGen.current++;
                  setIsFetchingMeta(false);
                  setAddTitle("");
                  setAddTags([]);
                } else if (hasBookmarks && !editingHref) {
                  fetchMetaForUrl(val);
                }
              }}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="none"
            />
            <input
              className="add-input"
              placeholder={isFetchingMeta ? "Fetching title…" : "Title"}
              value={addTitle}
              onChange={(e) => setAddTitle(e.currentTarget.value)}
              spellCheck={false}
            />
            <div className="tag-field-wrap">
              <div className="tag-field">
                {addTags.map((tag) => (
                  <span className="tag-chip" key={tag}>
                    {tag}
                    <button
                      type="button"
                      className="tag-chip-remove"
                      onClick={() => setAddTags((t) => t.filter((x) => x !== tag))}
                    >×</button>
                  </span>
                ))}
                <input
                  className="tag-chip-input"
                  placeholder={addTags.length === 0 ? "Add tag…" : ""}
                  value={tagInput}
                  onChange={(e) => {
                    setTagInput(e.currentTarget.value);
                    setTagSuggestionsOpen(true);
                  }}
                  onFocus={() => setTagSuggestionsOpen(true)}
                  onBlur={() => setTimeout(() => setTagSuggestionsOpen(false), 150)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === "," || e.key === " ") && tagInput.trim()) {
                      e.preventDefault();
                      const t = tagInput.trim().replace(/,$/, "");
                      if (t && !addTags.includes(t)) setAddTags((prev) => [...prev, t]);
                      setTagInput("");
                    } else if (e.key === "Backspace" && !tagInput && addTags.length > 0) {
                      setAddTags((prev) => prev.slice(0, -1));
                    }
                  }}
                  spellCheck={false}
                />
              </div>
              {tagSuggestionsOpen && (() => {
                const q = tagInput.toLowerCase();
                const suggestions = userTags
                  .filter((t) => !addTags.includes(t) && (!q || t.toLowerCase().startsWith(q)))
                  .slice(0, 6);
                if (suggestions.length === 0) return null;
                return (
                  <div className="tag-suggestions">
                    {suggestions.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className="tag-suggestion"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setAddTags((prev) => [...prev, t]);
                          setTagInput("");
                        }}
                      >{t}</button>
                    ))}
                  </div>
                );
              })()}
            </div>
            <div className="add-actions">
              {editingHref && (
                <button
                  className="btn-cancel-edit"
                  type="button"
                  onClick={() => {
                    setEditingHref(null);
                    setAddUrl("");
                    setAddTitle("");
                    setAddTags([]);
                    setTagInput("");
                    setAddStatus("idle");
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                className={`btn-add${addStatus === "saved" ? " btn-add-saved" : ""}`}
                type="submit"
                disabled={isAdding || !addUrl.trim()}
              >
                {isAdding
                  ? <>{editingHref ? "↓ Save" : "+ Add"}<LoadingDots /></>
                  : addStatus === "saved"
                    ? "✓ Saved"
                    : editingHref ? "↓ Save" : "+ Add"}
              </button>
            </div>
          </form>

          {/* List header */}
          <div className="list-header">
            <span>Recent</span>
            {isSyncing && <span className="list-header-syncing">syncing<LoadingDots /></span>}
          </div>

          {/* Bookmarks or empty */}
          {hasBookmarks ? (
            <div className="bookmark-list">
              {bookmarks.map((bm, i) => (
                <BookmarkRow
                  bookmark={bm}
                  key={bm.href_norm}
                  animationDelay={Math.min(i * 40, 240)}
                  onDelete={async (href) => {
                    await invoke("delete_bookmark", { href });
                    await loadState();
                  }}
                  onEdit={handleEditBookmark}
                />
              ))}
              {hasMoreBookmarks && (
                <button
                  className="load-more"
                  onClick={loadMore}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? <>loading<LoadingDots /></> : "load more"}
                </button>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <p className="empty-hint">
                Add your first link above or wait for sync.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
    </div>
  );
}

export default App;
