# Pinboarder

![Pinboarder v 0.1.0](public/v0.1.0.png)

A retro-modern themed macOS menubar app for [Pinboard](https://pinboard.in). 

## Features

- Open from the macOS menu bar
- Add websites instantly to your pinboard using URLs
- Titles fetched automatically
- Tags suggested from your existing library
- Remove entries directly
- Status indicator shows sync state

## Setup

1. Open the app — the panel appears from the menu bar icon
2. Paste your Pinboard API token (`username:TOKEN`)
   → Find it at [pinboard.in/settings/password](https://pinboard.in/settings/password)
3. The app syncs your bookmarks and is ready to use

## Development

```bash
npm install
npm run tauri dev
```

## Tech

- Designed using [Variant.com](https://variant.com/)
- Coded by Codex and Claude Code
- [Tauri v2](https://tauri.app) + React 19 + TypeScript
- SQLite (via `rusqlite`) for local bookmark cache
- Pinboard v1 API (`posts/all`, `posts/add`, `posts/delete`, `tags/get`)
- [Inter](https://rsms.me/inter/) — UI chrome and structural elements
- [Space Mono](https://fonts.google.com/specimen/Space+Mono) — data, inputs, and instructional text
