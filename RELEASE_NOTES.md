# Pinboarder v0.2.0

## What's new

### Bug fixes
- **Tag dropdown arrow navigation** — ArrowDown now opens the dropdown if it was closed, and ArrowUp from the first item deselects back to the input (no longer stuck at index 0)
- **Dock icon hidden on launch** — app no longer briefly appears in the macOS Dock when starting; `LSUIElement` is now set at the plist level

### UX improvements
- Recent tags surfaced first in tag suggestions (stored locally, max 3)
- Keyboard navigation for the header options menu and bookmark row context menu (ArrowUp/Down, Escape to close and return focus)
- Header options menu closes on blur (focus leaving the menu area)

---

# Pinboarder v0.1.0

First public release.

## What's in this release

### Security
- **API token stored in Tauri Stronghold** — encrypted vault using Argon2id key derivation, stored in `~/Library/Application Support/com.trine.pinboarder/`. Token is never written to SQLite or localStorage.
- **Sync logs no longer leak bookmark URLs** — skipped-href and flush log lines now omit the URL.
- **Concurrent sync guard** — `initial_sync`, `sync_once`, and `flush_pending_writes` use a non-blocking `try_lock` so overlapping sync paths (background loop + quick-add) are safely serialised.

### Core features
- Open from the macOS menu bar — panel appears below the tray icon, hides on blur
- Add bookmarks instantly — paste a URL, title and tags are fetched automatically
- Tag suggestions from your existing Pinboard library
- Edit and delete bookmarks inline
- Background sync every 3 minutes; manual "Sync now" available
- Paginated bookmark list with "load more"

### UI & polish
- Staggered pop-in animation for bookmark rows
- Button-level feedback: saving dots → green "✓ Saved" → fades back to red
- Syncing indicator next to "Recent" header while sync is in progress
- Animated loading dots on Connect, load more, and saving states
- Bookmark row context menu always opens above the trigger — no clipping at panel bottom
- Clearing the URL field resets auto-fetched title and tags
- Meta fetch cancelled if form is submitted before it completes (race condition fix)

## Requirements

- macOS 13 Ventura or later
