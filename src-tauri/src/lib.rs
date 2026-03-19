mod core;

use crate::core::{Bookmark, BookmarkPage, PageMeta, PinboardCore, SyncStatus};
use std::sync::{Arc, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    ActivationPolicy, AppHandle, Emitter, Manager, PhysicalPosition, Position, Rect, WindowEvent,
    Wry,
};

#[derive(Clone)]
struct SharedState {
    core: Arc<PinboardCore>,
    last_shown_at: Arc<Mutex<Option<std::time::Instant>>>,
}

#[tauri::command]
async fn set_api_token(state: tauri::State<'_, SharedState>, token: String) -> Result<(), String> {
    state.core.set_token(token.trim())?;
    Ok(())
}

#[tauri::command]
async fn get_recent_bookmarks(
    state: tauri::State<'_, SharedState>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Bookmark>, String> {
    state.core.list_recent(limit, offset)
}

#[tauri::command]
async fn get_recent_bookmarks_page(
    state: tauri::State<'_, SharedState>,
    limit: i64,
    offset: i64,
) -> Result<BookmarkPage, String> {
    state.core.list_recent_page(limit, offset)
}

#[tauri::command]
async fn get_bookmark_count(state: tauri::State<'_, SharedState>) -> Result<i64, String> {
    state.core.bookmark_count()
}

#[tauri::command]
async fn quick_add_bookmark(
    state: tauri::State<'_, SharedState>,
    url: String,
    title: String,
    tags: String,
) -> Result<(), String> {
    if !state.core.has_token() {
        return Err("API token missing. Set your token first.".to_string());
    }
    state.core.queue_add(url.trim(), title.trim(), tags.trim())?;
    state.core.flush_pending_writes().await?;
    Ok(())
}

#[tauri::command]
async fn fetch_page_meta(state: tauri::State<'_, SharedState>, url: String) -> Result<PageMeta, String> {
    state.core.fetch_page_meta(&url).await
}

#[tauri::command]
async fn delete_bookmark(state: tauri::State<'_, SharedState>, href: String) -> Result<(), String> {
    state.core.delete_bookmark(&href).await
}

#[tauri::command]
async fn get_user_tags(state: tauri::State<'_, SharedState>) -> Result<Vec<String>, String> {
    state.core.get_user_tags().await
}

#[tauri::command]
async fn sync_now(state: tauri::State<'_, SharedState>, app: AppHandle) -> Result<(), String> {
    app_sync_log("sync_now command started");
    state.core.initial_sync().await?;
    state.core.mark_manual_sync_success()?;
    refresh_recent_and_tray(&app, &state)?;
    app_sync_log("sync_now command completed");
    Ok(())
}

#[tauri::command]
async fn get_sync_status(state: tauri::State<'_, SharedState>) -> Result<SyncStatus, String> {
    state.core.get_status()
}

#[tauri::command]
async fn has_api_token(state: tauri::State<'_, SharedState>) -> Result<bool, String> {
    Ok(state.core.has_token())
}

#[tauri::command]
async fn clear_api_token(state: tauri::State<'_, SharedState>) -> Result<(), String> {
    state.core.clear_token()
}

fn build_tray_menu(app: &tauri::AppHandle, _recent: &[Bookmark]) -> Result<tauri::menu::Menu<Wry>, String> {
    // Minimal right-click menu — panel UI handles sync, token reset, etc.
    MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("quit", "Quit Pinboarder").build(app).map_err(to_string_err)?)
        .build()
        .map_err(to_string_err)
}

fn refresh_recent_and_tray(app: &AppHandle, state: &SharedState) -> Result<(), String> {
    let status = state.core.get_status()?;
    if let Some(tray) = app.tray_by_id("pinboarder-tray") {
        let tooltip = format_sync_tooltip(&status);
        let _ = tray.set_tooltip(Some(tooltip));
    }
    let _ = app.emit("recent-updated", ());
    Ok(())
}

fn format_sync_tooltip(status: &SyncStatus) -> String {
    if let Some(err) = &status.last_error {
        return format!("Pinboarder sync error: {}", err);
    }
    match status.last_sync_epoch {
        Some(ts) => {
            let now = chrono::Utc::now().timestamp();
            let mins = ((now - ts).max(0)) / 60;
            format!("Pinboarder synced {}m ago", mins)
        }
        None => "Pinboarder not synced yet".to_string(),
    }
}

fn on_tray_event(app: &AppHandle, event: tauri::menu::MenuEvent, _state: &SharedState) {
    if event.id().as_ref() == "quit" {
        app.exit(0);
    }
}

fn toggle_panel_at_tray(app: &AppHandle, rect: Rect, state: &SharedState) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            let _ = window.hide();
            return;
        }

        let scale = window.scale_factor().unwrap_or(1.0);
        let rect_pos = rect.position.to_physical::<f64>(scale);
        let rect_size = rect.size.to_physical::<f64>(scale);
        let win_size = window.outer_size().unwrap_or(tauri::PhysicalSize { width: 420, height: 620 });
        let panel_w = win_size.width as f64;
        let panel_h = win_size.height as f64;

        let mut x = rect_pos.x + (rect_size.width / 2.0) - (panel_w / 2.0);
        // 2px gap so the arrow tip just clears the menu bar
        let mut y = rect_pos.y + rect_size.height + 2.0;

        // Clamp to visible screen area to handle notch, small screens, multi-monitor
        if let Ok(Some(monitor)) = window.primary_monitor() {
            let mpos = monitor.position();
            let msize = monitor.size();
            let mx = mpos.x as f64;
            let my = mpos.y as f64;
            let mw = msize.width as f64;
            let mh = msize.height as f64;
            x = x.max(mx + 8.0).min(mx + mw - panel_w - 8.0);
            y = y.min(my + mh - panel_h - 8.0);
        }

        let _ = window.set_position(Position::Physical(PhysicalPosition::new(
            x.round() as i32,
            y.round() as i32,
        )));

        // Record show time for blur debounce
        if let Ok(mut t) = state.last_shown_at.lock() {
            *t = Some(std::time::Instant::now());
        }

        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn start_sync_loop(app: &AppHandle, state: SharedState) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        app_sync_log("background sync loop started");
        if let Err(err) = state.core.initial_sync().await {
            app_sync_log(&format!("background initial_sync failed: {}", err));
        }
        if let Err(err) = refresh_recent_and_tray(&app_handle, &state) {
            app_sync_log(&format!("background refresh_recent_and_tray failed: {}", err));
        }
        loop {
            app_sync_log("background sync tick");
            if let Err(err) = state.core.sync_once().await {
                app_sync_log(&format!("background sync_once failed: {}", err));
            }
            if let Err(err) = refresh_recent_and_tray(&app_handle, &state) {
                app_sync_log(&format!("background refresh_recent_and_tray failed: {}", err));
            }
            tokio::time::sleep(std::time::Duration::from_secs(180)).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_stronghold::Builder::new(|password| {
            // Reduced params (m=4096, t=1, p=1) — fast enough for a local desktop vault
            // while still deriving a proper 32-byte key. The vault file lives in
            // appLocalDataDir which macOS already protects via sandboxing.
            let params = argon2::Params::new(4096, 1, 1, Some(32))
                .expect("argon2 params invalid");
            let argon2 = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
            let mut key = [0u8; 32];
            argon2
                .hash_password_into(password.as_bytes(), b"pinboarder-vault-salt", &mut key)
                .expect("argon2 key derivation failed");
            key.to_vec()
        }).build())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::Focused(false) = event {
                    // Debounce: don't hide if window was just shown (avoids accidental closes
                    // during tray-click toggle transitions)
                    let should_hide = window
                        .state::<SharedState>()
                        .last_shown_at
                        .lock()
                        .map(|t| {
                            t.map(|instant| instant.elapsed() > std::time::Duration::from_millis(300))
                                .unwrap_or(true)
                        })
                        .unwrap_or(true);
                    if should_hide {
                        let _ = window.hide();
                    }
                }
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);

            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(to_string_err)?;
            let core = Arc::new(PinboardCore::new(&app_data_dir)?);
            let shared = SharedState {
                core,
                last_shown_at: Arc::new(Mutex::new(None)),
            };
            app.manage(shared.clone());

            let menu = build_tray_menu(app.handle(), &[])?;
            let state_for_handler = shared.clone();
            // Tray icon rendered from SVG at build time (raw RGBA: 4 bytes width, 4 bytes height, then pixels)
            const TRAY_ICON_RAW: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/tray-icon.raw"));
            let width = u32::from_le_bytes(TRAY_ICON_RAW[0..4].try_into().unwrap());
            let height = u32::from_le_bytes(TRAY_ICON_RAW[4..8].try_into().unwrap());
            let tray_icon = tauri::image::Image::new_owned(TRAY_ICON_RAW[8..].to_vec(), width, height);

            let _tray = TrayIconBuilder::with_id("pinboarder-tray")
                .icon(tray_icon)
                .icon_as_template(true) // adapts to macOS light/dark mode
                .menu(&menu)
                // Left-click shows the panel; right-click shows the context menu
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    on_tray_event(app, event, &state_for_handler);
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        rect,
                        button,
                        button_state,
                        ..
                    } = event
                    {
                        if button == MouseButton::Left && button_state == MouseButtonState::Up {
                            let app = tray.app_handle();
                            let state = app.state::<SharedState>();
                            toggle_panel_at_tray(&app, rect, &state);
                        }
                    }
                })
                .build(app)
                .map_err(to_string_err)?;

            // Always start hidden — tray click positions and shows the panel
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            start_sync_loop(app.handle(), shared);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_api_token,
            clear_api_token,
            get_recent_bookmarks,
            get_recent_bookmarks_page,
            get_bookmark_count,
            quick_add_bookmark,
            fetch_page_meta,
            delete_bookmark,
            get_user_tags,
            sync_now,
            get_sync_status,
            has_api_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn to_string_err<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

fn app_sync_log(message: &str) {
    eprintln!(
        "[pinboarder-sync-app][{}] {}",
        chrono::Utc::now().to_rfc3339(),
        message
    );
}
