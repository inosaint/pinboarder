# Pinboarder v0.3.0

## What's new

### Jev tag suggestions (optional)
- Add a [TypeSafe](https://docs.typesafe.ai) API key from the ••• menu and Jev picks tags from your own Pinboard library for each new link
- Works from the page's URL, title, description and keywords; falls back to page keywords when Jev is unavailable
- Key is verified before it's saved, and stored in the macOS Keychain — never in the app's web layer
- Clear messages for a rejected key, a used-up usage limit or rate limiting; the app keeps working offline without Jev

### Security
- **Pinboard token moved to the macOS Keychain** — replaces the Stronghold vault, whose password shipped inside the app. Existing tokens migrate automatically on first launch
- **Token no longer leaks into error messages** — failed Pinboard requests had the full request URL, including `auth_token`, in their error text, which reached logs, the local database and the UI

### Pinboard sync status
- Clear messages for a rejected token or lapsed subscription, being offline, Pinboard outages and rate limiting, with a matching sync badge
- Links added while offline are kept and retried instead of failing permanently, and no longer get stuck mid-send

### Tags and forms
- Enter now adds the highlighted tag suggestion, which is the top match while you type
- Focus returns to the URL field after saving, instead of staying in the tag field
- Menu items in the ••• menus now respond to the first click
- Pasted URLs fetch the page immediately, without the 0.7s pause used for typing

### Appearance
- New app icon, built with Icon Composer: adapts to Default, Dark, Tinted and Clear appearance modes on macOS 26
- The panel pops out of the menu bar nub each time it opens, and respects Reduce Motion
- Removed the stray outline around the panel (the native window shadow)

### Build
- `npm run build:signed` — local signed build; reads your certificate name from `.env.local`
- `npm run build:release` — ad-hoc signed universal `.dmg` (Apple Silicon + Intel) for releases
- `npm run icon:compile` — regenerates icon files from `src-tauri/icons/Pinboarder.icon`

---

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
