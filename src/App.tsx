import { FormEvent, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
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
const LOCAL_TOKEN_KEY = `${STRONGHOLD_CLIENT_NAME}:${STRONGHOLD_TOKEN_KEY}`;

async function readStoredToken(): Promise<string | null> {
  try {
    // Stronghold intentionally disabled for now; use local persisted token copy.
    const token = window.localStorage.getItem(LOCAL_TOKEN_KEY);
    return token?.trim() || null;
  } catch {
    return null;
  }
}

async function writeStoredToken(token: string): Promise<void> {
  // Stronghold intentionally disabled for now; use local persisted token copy.
  window.localStorage.setItem(LOCAL_TOKEN_KEY, token);
}

async function clearStoredToken(): Promise<void> {
  try {
    window.localStorage.removeItem(LOCAL_TOKEN_KEY);
  } catch {
    // ignore cleanup failures, app state is still cleared
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

function BookmarkRow({
  bookmark,
  onDelete,
  onEdit,
}: {
  bookmark: Bookmark;
  onDelete: (href: string) => Promise<void>;
  onEdit: (bookmark: Bookmark) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
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
                  const menuH = 116; // ~3 items
                  const right = window.innerWidth - rect.right;
                  const panelBottom = document.querySelector(".app")?.getBoundingClientRect().bottom ?? window.innerHeight;
                  if (rect.bottom + menuH > panelBottom) {
                    // Open up
                    setMenuPos({ bottom: window.innerHeight - rect.top + 4, right });
                  } else {
                    // Open down, clamped within panel
                    setMenuPos({ top: Math.min(rect.bottom + 4, panelBottom - menuH - 4), right });
                  }
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
      await writeStoredToken(token);
      await invoke("set_api_token", { token });
      syncLog("set_api_token completed");
      setHasToken(true);
      setTokenInput("");
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
    metaFetchTimer.current = setTimeout(async () => {
      setIsFetchingMeta(true);
      try {
        const meta = await invoke<{ title: string; tags: string[] }>("fetch_page_meta", { url: normalized });
        if (meta.title) setAddTitle(meta.title);
        if (meta.tags.length > 0) setAddTags(meta.tags);
      } catch {
        // silently ignore — user can fill in manually
      } finally {
        setIsFetchingMeta(false);
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
    if (savedTimer.current) clearTimeout(savedTimer.current);
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
      const wasEditing = !!editingHref;
      setEditingHref(null);
      setAddStatus("saved");
      savedTimer.current = setTimeout(() => setAddStatus("idle"), wasEditing ? 0 : 2000);
      await loadState();
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
    await clearStoredToken();
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
    invoke<string[]>("get_user_tags").then(setUserTags).catch(() => {});
    (async () => {
      const token = await readStoredToken();
      syncLog("startup readStoredToken", { hasToken: !!token });
      if (active && token) {
        await invoke("set_api_token", { token });
        syncLog("startup set_api_token from local store success");
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
              {isSubmittingToken ? "Connecting…" : "Connect"}
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
                setAddUrl(e.currentTarget.value);
                if (hasBookmarks && !editingHref) {
                  fetchMetaForUrl(e.currentTarget.value);
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
              {addStatus === "saving" && (
                <span className="add-status add-status-saving">saving…</span>
              )}
              {addStatus === "saved" && (
                <span className="add-status add-status-saved">saved ✓</span>
              )}
              <button
                className="btn-add"
                type="submit"
                disabled={isAdding || !addUrl.trim()}
              >
                {editingHref ? "↓ Save" : "+ Add"}
              </button>
            </div>
          </form>

          {/* List header */}
          <div className="list-header">
            <span>Recent</span>
          </div>

          {/* Bookmarks or empty */}
          {hasBookmarks ? (
            <div className="bookmark-list">
              {bookmarks.map((bm) => (
                <BookmarkRow
                  bookmark={bm}
                  key={bm.href_norm}
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
                  {isLoadingMore ? "loading…" : "load more"}
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
