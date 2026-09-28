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
  last_error_kind?: "auth" | "offline" | "rate_limited" | "server" | "error" | null;
};

const SYNC_ERROR_LABELS: Record<string, string> = {
  auth: "token rejected",
  offline: "offline",
  rate_limited: "rate limited",
  server: "pinboard down",
};

type BookmarkPage = {
  items: Bookmark[];
  has_more: boolean;
};

type OpenUrlEvent = { url: string };

type PageMeta = { title: string; description: string; tags: string[] };

type JevStatus = "unknown" | "ready" | "no_key" | "invalid" | "limit" | "rate_limited" | "offline" | "error";
type JevFailure = { kind: JevStatus; message: string };

function asJevFailure(err: unknown): JevFailure {
  if (err && typeof err === "object" && "kind" in err) return err as JevFailure;
  return { kind: "error", message: String(err) };
}

// Statuses where calling Jev again can't succeed until the user acts.
const JEV_BLOCKED: JevStatus[] = ["no_key", "invalid", "limit"];

// Legacy token storage (v0.1–v0.2). The Pinboard token now lives in the macOS
// Keychain via Rust; this is kept only to migrate existing installs, then wiped.
// Safe to remove once no one is upgrading from v0.2.
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

  useEffect(() => {
    if (!menuOpen) return;
    const id = setTimeout(() => {
      menuRef.current?.querySelector<HTMLButtonElement>(".bm-row-menu-item:not(:disabled)")?.focus();
    }, 0);
    return () => clearTimeout(id);
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
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
        } else if (e.key === "Enter" && e.target === e.currentTarget && !deleting && canOpenExternalUrl(bookmark.href)) {
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
          onBlur={(e) => {
            if (!menuRef.current?.contains(e.relatedTarget as Node)) {
              setMenuOpen(false);
            }
          }}
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
              onMouseDown={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setMenuOpen(false);
                  btnRef.current?.focus();
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".bm-row-menu-item:not(:disabled)"));
                  const idx = items.indexOf(document.activeElement as HTMLButtonElement);
                  const next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
                  items[next]?.focus();
                }
              }}
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
  const iconBtnRef = useRef<HTMLButtonElement>(null);

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
  const [highlightedTagIndex, setHighlightedTagIndex] = useState(-1);
  const [recentTags, setRecentTags] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("pinboarder_recent_tags") || "[]"); }
    catch { return []; }
  });
  const [isAdding, setIsAdding] = useState(false);
  const [addStatus, setAddStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [isFetchingMeta, setIsFetchingMeta] = useState(false);
  const [editingHref, setEditingHref] = useState<string | null>(null);
  const metaFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaFetchGen = useRef(0);
  const urlWasPasted = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Jev (TypeSafe) key — the key itself never reaches the webview after submit.
  const [hasJevKey, setHasJevKey] = useState(false);
  const [jevSettingsOpen, setJevSettingsOpen] = useState(false);
  const [jevKeyInput, setJevKeyInput] = useState("");
  const [isSavingJevKey, setIsSavingJevKey] = useState(false);
  const [jevKeyError, setJevKeyError] = useState<string | null>(null);
  const [jevStatus, setJevStatus] = useState<JevStatus>("unknown");
  const [jevMessage, setJevMessage] = useState("");
  const [isPickingTags, setIsPickingTags] = useState(false);
  const lastJevCheckAt = useRef(0);
  // fetchMetaForUrl is a stable callback, so it reads these through refs
  const jevStatusRef = useRef<JevStatus>("unknown");
  jevStatusRef.current = jevStatus;
  const tagCandidatesRef = useRef<string[]>([]);
  tagCandidatesRef.current = [...new Set([...recentTags, ...userTags])];

  const applyJevFailure = useCallback((err: unknown) => {
    const f = asJevFailure(err);
    setJevStatus(f.kind);
    setJevMessage(f.message);
  }, []);

  const runJevHandshake = useCallback(() => {
    lastJevCheckAt.current = Date.now();
    invoke("check_jev")
      .then(() => { setJevStatus("ready"); setJevMessage(""); })
      .catch(applyJevFailure);
  }, [applyJevFailure]);

  const hasBookmarks = bookmarks.length > 0;

  const tagSuggestions = useMemo(() => {
    const q = tagInput.toLowerCase();
    const recent = recentTags
      .filter((t) => !addTags.includes(t) && (!q || t.toLowerCase().startsWith(q)))
      .slice(0, 3);
    const other = userTags
      .filter((t) => !addTags.includes(t) && !recent.includes(t) && (!q || t.toLowerCase().startsWith(q)))
      .slice(0, Math.max(0, 6 - recent.length));
    return { recent, all: [...recent, ...other] };
  }, [tagInput, recentTags, userTags, addTags]);

  // While typing, the top suggestion is implicitly highlighted so Enter picks it.
  const activeTagIndex =
    highlightedTagIndex >= 0 ? highlightedTagIndex : tagInput.trim() && tagSuggestions.all.length > 0 ? 0 : -1;

  const syncInfo = useMemo(() => {
    if (isSyncing) return { label: "syncing", tone: "syncing" as const };
    if (status?.last_error) {
      const kind = status.last_error_kind ?? "error";
      // Offline and rate limiting fix themselves; auth/server/unknown need attention
      const tone = kind === "offline" || kind === "rate_limited" ? ("warn" as const) : ("error" as const);
      return { label: SYNC_ERROR_LABELS[kind] ?? "error", tone };
    }
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
      // Rust validates the token and stores it in the Keychain
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

  // Typed URLs wait for a pause; pasted URLs are complete, so fetch right away.
  const fetchMetaForUrl = useCallback((url: string, delayMs = 700) => {
    if (metaFetchTimer.current) clearTimeout(metaFetchTimer.current);
    const normalized = url.includes("://") ? url : `https://${url}`;
    try { new URL(normalized); } catch { return; } // not a valid URL yet
    const gen = ++metaFetchGen.current;
    metaFetchTimer.current = setTimeout(async () => {
      setIsFetchingMeta(true);
      try {
        const meta = await invoke<PageMeta>("fetch_page_meta", { url: normalized });
        if (gen !== metaFetchGen.current) return; // form was submitted/cleared, discard
        if (meta.title) setAddTitle(meta.title);
        const candidates = tagCandidatesRef.current;
        if (!JEV_BLOCKED.includes(jevStatusRef.current) && candidates.length > 0) {
          // Jev picks from the user's own tags; page keywords are only context for it
          setIsPickingTags(true);
          try {
            const picked = await invoke<string[]>("suggest_tags", {
              url: normalized,
              title: meta.title,
              description: meta.description,
              pageKeywords: meta.tags,
              candidates,
            });
            setJevStatus("ready");
            setJevMessage("");
            if (gen !== metaFetchGen.current) return;
            if (picked.length > 0) setAddTags((prev) => [...new Set([...prev, ...picked])]);
          } catch (err) {
            // No Jev (offline, out of usage…) — fall back to the page's own keywords
            applyJevFailure(err);
            if (gen === metaFetchGen.current && meta.tags.length > 0) setAddTags(meta.tags);
          } finally {
            if (gen === metaFetchGen.current) setIsPickingTags(false);
          }
        } else if (meta.tags.length > 0) {
          setAddTags(meta.tags);
        }
      } catch {
        // silently ignore — user can fill in manually
      } finally {
        if (gen === metaFetchGen.current) setIsFetchingMeta(false);
      }
    }, delayMs);
  }, [applyJevFailure]);

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
    setIsPickingTags(false);
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
      if (addTags.length > 0) {
        const updated = [...new Set([...addTags, ...recentTags])].slice(0, 3);
        setRecentTags(updated);
        localStorage.setItem("pinboarder_recent_tags", JSON.stringify(updated));
      }
      setAddUrl("");
      setAddTitle("");
      setAddTags([]);
      setTagInput("");
      setTagSuggestionsOpen(false);
      setHighlightedTagIndex(-1);
      setEditingHref(null);
      // Reset focus so the next panel open starts at the URL field, not the tag field.
      urlInputRef.current?.focus();
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

  function closeJevSettings() {
    setJevSettingsOpen(false);
    setJevKeyInput("");
    setJevKeyError(null);
  }

  async function handleSaveJevKey(e: FormEvent) {
    e.preventDefault();
    if (!jevKeyInput.trim()) return;
    setIsSavingJevKey(true);
    setJevKeyError(null);
    try {
      await invoke("set_jev_key", { key: jevKeyInput });
      setHasJevKey(true);
      setJevStatus("ready");
      setJevMessage("");
      closeJevSettings();
    } catch (err) {
      setJevKeyError(asJevFailure(err).message);
    } finally {
      setIsSavingJevKey(false);
    }
  }

  async function handleResetJevKey() {
    setMenuOpen(false);
    try {
      await invoke("clear_jev_key");
      setHasJevKey(false);
      setJevStatus("no_key");
      setJevMessage("");
    } catch (err) {
      console.error("clear_jev_key failed", err);
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
      let restored = await invoke<boolean>("restore_api_token").catch((err) => {
        console.error("restore_api_token failed", err);
        return false;
      });
      if (!restored) {
        // One-time migration from the legacy Stronghold vault / localStorage fallback
        const legacy = await readStoredToken();
        if (legacy) {
          await invoke("set_api_token", { token: legacy });
          await clearStoredToken();
          restored = true;
          syncLog("migrated token from legacy storage to Keychain");
        }
      }
      syncLog("startup token restore", { restored });
      if (active && restored) {
        invoke<string[]>("get_user_tags").then(setUserTags).catch(() => {});
      }
      invoke<boolean>("has_jev_key")
        .then((has) => {
          if (!active) return;
          setHasJevKey(has);
          if (has) runJevHandshake();
          else setJevStatus("no_key");
        })
        .catch(() => {});
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

  // Re-run the Jev handshake when the panel opens, if the last attempt failed
  // for a reason that can fix itself (back online, account topped up).
  useEffect(() => {
    const onFocus = () => {
      const retryable: JevStatus[] = ["limit", "rate_limited", "offline", "error"];
      if (hasJevKey && retryable.includes(jevStatus) && Date.now() - lastJevCheckAt.current > 60_000) {
        runJevHandshake();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [hasJevKey, jevStatus, runJevHandshake]);

  // Replay the open animation each time the tray shows the panel
  useEffect(() => {
    const shown = listen("panel-shown", () => {
      const el = panelRef.current;
      if (!el) return;
      el.classList.remove("panel-closed", "panel-pop");
      void el.offsetWidth; // restart the CSS animation
      el.classList.add("panel-pop");
    });
    // Reset while hidden so the next open doesn't flash the old frame first
    const hidden = listen("panel-hidden", () => {
      const el = panelRef.current;
      if (!el) return;
      el.classList.remove("panel-pop");
      el.classList.add("panel-closed");
    });
    return () => {
      shown.then((f) => f());
      hidden.then((f) => f());
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

  // Focus first dropdown item when header menu opens
  useEffect(() => {
    if (!menuOpen) return;
    const id = setTimeout(() => {
      menuRef.current?.querySelector<HTMLButtonElement>(".dropdown-item:not(:disabled)")?.focus();
    }, 0);
    return () => clearTimeout(id);
  }, [menuOpen]);

  return (
    <div className="panel-root" ref={panelRef}>
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
              title={status?.last_error ?? "Sync status"}
            >
              <span className="sync-dot" />
              <span className="sync-label">{syncInfo.label}</span>
            </div>
            <div
              className="menu-wrap"
              ref={menuRef}
              onBlur={(e) => {
                if (!menuRef.current?.contains(e.relatedTarget as Node)) {
                  setMenuOpen(false);
                }
              }}
            >
              <button
                ref={iconBtnRef}
                className="icon-btn"
                onClick={() => setMenuOpen((v) => !v)}
                title="Options"
              >
                <span className="dots">•••</span>
              </button>
              {menuOpen && (
                <div
                  className="dropdown"
                  // WebKit doesn't focus buttons on click, so mousedown would blur the
                  // focused item and close the menu before the click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setMenuOpen(false);
                      iconBtnRef.current?.focus();
                    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".dropdown-item:not(:disabled)"));
                      const idx = items.indexOf(document.activeElement as HTMLButtonElement);
                      const next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
                      items[next]?.focus();
                    }
                  }}
                >
                  <button
                    className="dropdown-item"
                    onClick={handleSync}
                    disabled={isSyncing}
                  >
                    {isSyncing ? "Syncing…" : "Sync now"}
                  </button>
                  {hasJevKey ? (
                    <button className="dropdown-item destructive" onClick={handleResetJevKey}>
                      Reset Jev API Key
                    </button>
                  ) : (
                    <button
                      className="dropdown-item"
                      onClick={() => {
                        setMenuOpen(false);
                        setJevKeyError(null);
                        setJevSettingsOpen(true);
                      }}
                    >
                      Add Jev API Key…
                    </button>
                  )}
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
      ) : jevSettingsOpen ? (
        <div
          className="setup-view"
          onKeyDown={(e) => {
            if (e.key === "Escape") closeJevSettings();
          }}
        >
          <h2 className="setup-title">Jev tag suggestions</h2>
          <p className="setup-desc">
            Optional. Add a TypeSafe API key and Jev will pick tags from your list for new links.
          </p>
          <form className="setup-form" onSubmit={handleSaveJevKey}>
            <input
              className="setup-input"
              type="password"
              placeholder="TypeSafe API key"
              value={jevKeyInput}
              onChange={(e) => setJevKeyInput(e.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="none"
              autoFocus
              disabled={isSavingJevKey}
            />
            <button
              className="btn-primary"
              type="submit"
              disabled={isSavingJevKey || !jevKeyInput.trim()}
            >
              {isSavingJevKey ? <>Checking<LoadingDots /></> : "Save"}
            </button>
          </form>
          {jevKeyError && <p className="setup-error">{jevKeyError}</p>}
          <button className="setup-link" type="button" onClick={closeJevSettings}>
            ← Back
          </button>
        </div>
      ) : (
        <div className="main-content">
          {status?.last_error && status.last_error_kind && status.last_error_kind !== "rate_limited" && (
            <div
              className={`status-notice status-notice-${status.last_error_kind === "offline" ? "warn" : "error"}`}
              role="status"
            >
              <span>{status.last_error}</span>
              {status.last_error_kind === "auth" && (
                <button className="status-notice-link" type="button" onClick={() => openUrl("https://pinboard.in/")}>
                  pinboard.in →
                </button>
              )}
            </div>
          )}
          {/* Add bookmark form */}
          <form className="add-form" onSubmit={handleAddBookmark}>
            <input
              ref={urlInputRef}
              className="add-input"
              placeholder="Paste URL..."
              value={addUrl}
              onPaste={() => { urlWasPasted.current = true; }}
              onChange={(e) => {
                const val = e.currentTarget.value;
                const pasted = urlWasPasted.current;
                urlWasPasted.current = false;
                setAddUrl(val);
                if (!val.trim()) {
                  if (metaFetchTimer.current) clearTimeout(metaFetchTimer.current);
                  metaFetchGen.current++;
                  setIsFetchingMeta(false);
                  setIsPickingTags(false);
                  setAddTitle("");
                  setAddTags([]);
                } else if (hasBookmarks && !editingHref) {
                  fetchMetaForUrl(val, pasted ? 0 : 700);
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
                  placeholder={isPickingTags ? "Jev is picking tags…" : addTags.length === 0 ? "Add tag…" : ""}
                  value={tagInput}
                  onChange={(e) => {
                    setTagInput(e.currentTarget.value);
                    setTagSuggestionsOpen(true);
                    setHighlightedTagIndex(-1);
                  }}
                  onFocus={() => setTagSuggestionsOpen(true)}
                  onBlur={() => setTimeout(() => { setTagSuggestionsOpen(false); setHighlightedTagIndex(-1); }, 150)}
                  onKeyDown={(e) => {
                    const allSuggestions = tagSuggestions.all;

                    if (e.key === "ArrowDown" && allSuggestions.length > 0) {
                      e.preventDefault();
                      setTagSuggestionsOpen(true);
                      setHighlightedTagIndex((i) => Math.min(i < 0 ? 0 : i + 1, allSuggestions.length - 1));
                    } else if (e.key === "ArrowUp" && tagSuggestionsOpen && allSuggestions.length > 0) {
                      e.preventDefault();
                      setHighlightedTagIndex((i) => (i <= 0 ? -1 : i - 1));
                    } else if (e.key === "Enter" && tagSuggestionsOpen && activeTagIndex >= 0 && allSuggestions[activeTagIndex]) {
                      e.preventDefault();
                      const t = allSuggestions[activeTagIndex];
                      if (!addTags.includes(t)) setAddTags((prev) => [...prev, t]);
                      setTagInput("");
                      setHighlightedTagIndex(-1);
                    } else if (e.key === "Escape") {
                      setTagSuggestionsOpen(false);
                      setHighlightedTagIndex(-1);
                    } else if (e.key === "Tab") {
                      setTagSuggestionsOpen(false);
                      setHighlightedTagIndex(-1);
                    } else if ((e.key === "Enter" || e.key === "," || e.key === " ") && tagInput.trim()) {
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
              {tagSuggestionsOpen && tagSuggestions.all.length > 0 && (
                  <div className="tag-suggestions">
                    {tagSuggestions.all.map((t, idx) => (
                      <button
                        key={t}
                        type="button"
                        tabIndex={-1}
                        className={`tag-suggestion${idx === activeTagIndex ? " highlighted" : ""}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setAddTags((prev) => [...prev, t]);
                          setTagInput("");
                          setHighlightedTagIndex(-1);
                        }}
                      >
                        {t}
                        {tagSuggestions.recent.includes(t) && (
                          <img src="/history.svg" className="tag-suggestion-icon" aria-hidden="true" />
                        )}
                      </button>
                    ))}
                  </div>
              )}
            </div>
            {hasJevKey && (jevStatus === "limit" || jevStatus === "invalid" || jevStatus === "rate_limited") && (
              <p className={`jev-notice jev-notice-${jevStatus}`} role="status">
                {jevStatus === "invalid"
                  ? "Jev key was rejected. Reset it from the ••• menu."
                  : jevMessage}
              </p>
            )}
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
