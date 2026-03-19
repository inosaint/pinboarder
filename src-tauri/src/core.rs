use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::time::{sleep, Duration};
use url::Url;
use uuid::Uuid;

const LEGACY_TOKEN_FILE_NAME: &str = "token";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub href: String,
    pub href_norm: String,
    pub title: String,
    pub tags: String,
    pub time_remote: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatus {
    pub pending_count: i64,
    pub last_sync_epoch: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookmarkPage {
    pub items: Vec<Bookmark>,
    pub has_more: bool,
}

pub struct PinboardCore {
    db_path: PathBuf,
    client: reqwest::Client,
    token_cache: Mutex<Option<String>>,
}

#[derive(Debug, Deserialize)]
struct RecentPost {
    href: String,
    description: String,
    #[serde(default)]
    tag: String,
    #[serde(default)]
    time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateResponse {
    #[serde(default)]
    update_time: Option<String>,
    #[serde(default)]
    time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AddResult {
    #[serde(default)]
    result_code: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PageMeta {
    pub title: String,
    pub tags: Vec<String>,
}

/// Extract <title>…</title> content
fn extract_title(html: &str) -> String {
    let lower = html.to_lowercase();
    let start = lower.find("<title").and_then(|i| lower[i..].find('>').map(|j| i + j + 1));
    let end = lower.find("</title>");
    match (start, end) {
        (Some(s), Some(e)) if s < e => html[s..e].trim().to_string(),
        _ => String::new(),
    }
}

/// Extract a meta attribute value by matching name/property and returning content="…"
fn meta_content<'a>(html: &'a str, attr: &str, value: &str) -> Option<&'a str> {
    let lower = html.to_lowercase();
    let needle = format!("{}=\"{}\"", attr, value);
    let pos = lower.find(&needle)?;
    // Walk back to find the opening < of this <meta> tag
    let tag_start = lower[..pos].rfind('<')?;
    let tag_end = tag_start + lower[tag_start..].find('>')?;
    let tag = &html[tag_start..=tag_end];
    let tag_lower = tag.to_lowercase();
    // Extract content="…"
    let c_pos = tag_lower.find("content=\"")? + "content=\"".len();
    let c_end = tag[c_pos..].find('"')?;
    Some(&tag[c_pos..c_pos + c_end])
}

fn extract_tags(html: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();

    // 1. <meta name="keywords" content="…">
    if let Some(kw) = meta_content(html, "name", "keywords") {
        for t in kw.split(',') {
            let t = t.trim().to_string();
            if !t.is_empty() && !tags.contains(&t) { tags.push(t); }
        }
    }

    // 2. <meta name="news_keywords" content="…">
    if let Some(kw) = meta_content(html, "name", "news_keywords") {
        for t in kw.split(',') {
            let t = t.trim().to_string();
            if !t.is_empty() && !tags.contains(&t) { tags.push(t); }
        }
    }

    // 3. Open Graph article tags: <meta property="article:tag" content="…">
    //    There may be multiple — scan all occurrences
    let lower = html.to_lowercase();
    let needle = "property=\"article:tag\"";
    let mut search_from = 0;
    while let Some(pos) = lower[search_from..].find(needle) {
        let abs = search_from + pos;
        if let Some(tag_start) = lower[..abs].rfind('<') {
            if let Some(rel_end) = lower[tag_start..].find('>') {
                let tag = &html[tag_start..tag_start + rel_end + 1];
                let tag_lower = tag.to_lowercase();
                if let Some(c_pos) = tag_lower.find("content=\"").map(|p| p + "content=\"".len()) {
                    if let Some(c_end) = tag[c_pos..].find('"') {
                        let t = tag[c_pos..c_pos + c_end].trim().to_string();
                        if !t.is_empty() && !tags.contains(&t) { tags.push(t); }
                    }
                }
            }
        }
        search_from = abs + needle.len();
    }

    // Limit to 8 tags — beyond that it's noise
    tags.truncate(8);
    tags
}

impl PinboardCore {
    pub fn new(app_data_dir: &std::path::Path) -> Result<Self, String> {
        std::fs::create_dir_all(app_data_dir).map_err(to_string_err)?;
        let db_path = app_data_dir.join("pinboarder.sqlite");
        let legacy_token_path = app_data_dir.join(LEGACY_TOKEN_FILE_NAME);
        let initial_token = std::fs::read_to_string(&legacy_token_path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if initial_token.is_some() {
            let _ = std::fs::remove_file(&legacy_token_path);
        }
        let core = Self {
            db_path,
            client: reqwest::Client::builder()
                .user_agent("pinboarder/0.1.0")
                .build()
                .map_err(to_string_err)?,
            token_cache: Mutex::new(initial_token),
        };
        core.migrate()?;
        Ok(core)
    }

    pub fn migrate(&self) -> Result<(), String> {
        let conn = self.conn()?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS bookmarks (
              href_norm TEXT PRIMARY KEY,
              href TEXT NOT NULL,
              title TEXT NOT NULL,
              tags TEXT NOT NULL DEFAULT '',
              time_remote TEXT,
              source TEXT NOT NULL,
              pending_write_id TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pending_writes (
              id TEXT PRIMARY KEY,
              dedupe_key TEXT NOT NULL UNIQUE,
              href TEXT NOT NULL,
              title TEXT NOT NULL,
              tags TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL,
              attempt_count INTEGER NOT NULL DEFAULT 0,
              next_attempt_at INTEGER NOT NULL DEFAULT 0,
              last_error TEXT,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_state (
              id INTEGER PRIMARY KEY CHECK(id = 1),
              last_update_time TEXT,
              last_sync_epoch INTEGER,
              next_generic_at INTEGER NOT NULL DEFAULT 0,
              next_recent_at INTEGER NOT NULL DEFAULT 0,
              backoff_seconds INTEGER NOT NULL DEFAULT 0,
              last_error TEXT
            );
            INSERT OR IGNORE INTO sync_state (id) VALUES (1);
            "#,
        )
        .map_err(to_string_err)?;
        Ok(())
    }

    pub fn set_token(&self, token: &str) -> Result<(), String> {
        if !token.contains(':') {
            return Err("Token must be in username:TOKEN format".to_string());
        }
        if let Ok(mut cache) = self.token_cache.lock() {
            *cache = Some(token.trim().to_string());
        }
        Ok(())
    }

    pub fn has_token(&self) -> bool {
        self.token_cache.lock().map(|c| c.is_some()).unwrap_or(false)
    }

    pub fn clear_token(&self) -> Result<(), String> {
        if let Ok(mut cache) = self.token_cache.lock() {
            *cache = None;
        }
        self.clear_local_cache()?;
        Ok(())
    }

    fn clear_local_cache(&self) -> Result<(), String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(to_string_err)?;
        tx.execute("DELETE FROM pending_writes", [])
            .map_err(to_string_err)?;
        tx.execute("DELETE FROM bookmarks", [])
            .map_err(to_string_err)?;
        tx.execute(
            "UPDATE sync_state
             SET last_update_time=NULL,
                 last_sync_epoch=NULL,
                 next_generic_at=0,
                 next_recent_at=0,
                 backoff_seconds=0,
                 last_error=NULL
             WHERE id=1",
            [],
        )
        .map_err(to_string_err)?;
        tx.commit().map_err(to_string_err)?;
        Ok(())
    }

    pub fn list_recent(&self, limit: i64, offset: i64) -> Result<Vec<Bookmark>, String> {
        if !self.has_token() {
            return Ok(Vec::new());
        }
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT href, href_norm, title, tags, time_remote, source
                 FROM bookmarks
                 ORDER BY COALESCE(time_remote, '9999-12-31T23:59:59Z') DESC, updated_at DESC, href_norm ASC
                 LIMIT ?1 OFFSET ?2",
            )
            .map_err(to_string_err)?;

        let rows = stmt
            .query_map(params![limit, offset], |row| {
                Ok(Bookmark {
                    href: row.get(0)?,
                    href_norm: row.get(1)?,
                    title: row.get(2)?,
                    tags: row.get(3)?,
                    time_remote: row.get(4)?,
                    source: row.get(5)?,
                })
            })
            .map_err(to_string_err)?;

        let mut out = Vec::new();
        for item in rows {
            out.push(item.map_err(to_string_err)?);
        }
        Ok(out)
    }

    pub fn list_recent_page(&self, limit: i64, offset: i64) -> Result<BookmarkPage, String> {
        if !self.has_token() {
            return Ok(BookmarkPage {
                items: Vec::new(),
                has_more: false,
            });
        }

        let page_size = limit.clamp(1, 100);
        let safe_offset = offset.max(0);
        let query_limit = page_size + 1;

        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT href, href_norm, title, tags, time_remote, source
                 FROM bookmarks
                 ORDER BY COALESCE(time_remote, '9999-12-31T23:59:59Z') DESC, updated_at DESC, href_norm ASC
                 LIMIT ?1 OFFSET ?2",
            )
            .map_err(to_string_err)?;

        let rows = stmt
            .query_map(params![query_limit, safe_offset], |row| {
                Ok(Bookmark {
                    href: row.get(0)?,
                    href_norm: row.get(1)?,
                    title: row.get(2)?,
                    tags: row.get(3)?,
                    time_remote: row.get(4)?,
                    source: row.get(5)?,
                })
            })
            .map_err(to_string_err)?;

        let mut out = Vec::new();
        for item in rows {
            out.push(item.map_err(to_string_err)?);
        }
        let has_more = out.len() as i64 > page_size;
        if has_more {
            out.truncate(page_size as usize);
        }
        Ok(BookmarkPage { items: out, has_more })
    }

    pub fn bookmark_count(&self) -> Result<i64, String> {
        if !self.has_token() {
            return Ok(0);
        }
        let conn = self.conn()?;
        conn.query_row("SELECT COUNT(*) FROM bookmarks", [], |row| row.get(0))
            .map_err(to_string_err)
    }

    pub fn get_status(&self) -> Result<SyncStatus, String> {
        if !self.has_token() {
            return Ok(SyncStatus {
                pending_count: 0,
                last_sync_epoch: None,
                last_error: None,
            });
        }
        let conn = self.conn()?;
        let pending_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pending_writes WHERE status IN ('queued', 'retry_wait', 'sending')",
                [],
                |row| row.get(0),
            )
            .map_err(to_string_err)?;
        let (last_sync_epoch, last_error): (Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT last_sync_epoch, last_error FROM sync_state WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(to_string_err)?;
        Ok(SyncStatus {
            pending_count,
            last_sync_epoch,
            last_error,
        })
    }

    pub fn mark_manual_sync_success(&self) -> Result<(), String> {
        if !self.has_token() {
            return Ok(());
        }
        let conn = self.conn()?;
        conn.execute(
            "UPDATE sync_state
             SET last_sync_epoch=?1, last_error=NULL
             WHERE id=1",
            params![now_epoch()],
        )
        .map_err(to_string_err)?;
        Ok(())
    }

    pub fn queue_add(&self, href: &str, title: &str, tags: &str) -> Result<(), String> {
        if href.trim().is_empty() || title.trim().is_empty() {
            return Err("url and title are required".to_string());
        }
        let href_norm = normalize_url(href)?;
        let now = now_epoch();
        let pending_id = Uuid::new_v4().to_string();
        let dedupe = dedupe_key(href, title, Utc::now())?;
        let conn = self.conn()?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM pending_writes
                 WHERE dedupe_key=?1
                   AND status IN ('queued', 'retry_wait', 'sending')
                 LIMIT 1",
                params![dedupe],
                |row| row.get(0),
            )
            .ok();
        if existing.is_some() {
            return Ok(());
        }
        conn.execute(
            "INSERT OR REPLACE INTO bookmarks
             (href_norm, href, title, tags, source, pending_write_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'local_pending', ?5, ?6)",
            params![href_norm, href, title, tags, pending_id, now],
        )
        .map_err(to_string_err)?;
        conn.execute(
            "INSERT INTO pending_writes
             (id, dedupe_key, href, title, tags, status, attempt_count, next_attempt_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 0, 0, ?6)",
            params![pending_id, dedupe, href, title, tags, now],
        )
        .map_err(to_string_err)?;
        Ok(())
    }

    pub async fn sync_once(&self) -> Result<(), String> {
        if !self.has_token() {
            return Ok(());
        }
        let changed = self.check_update().await?;
        if changed {
            self.pull_recent().await?;
        }
        self.flush_pending_writes().await?;
        Ok(())
    }

    pub async fn initial_sync(&self) -> Result<(), String> {
        if !self.has_token() {
            return Ok(());
        }
        self.pull_recent().await?;
        self.flush_pending_writes().await?;
        Ok(())
    }

    /// Fetch all tags from Pinboard, sorted by usage count descending.
    pub async fn get_user_tags(&self) -> Result<Vec<String>, String> {
        let token = self.get_token()?;
        let response = self
            .client
            .get("https://api.pinboard.in/v1/tags/get")
            .query(&[("auth_token", token.as_str()), ("format", "json")])
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
            .map_err(to_string_err)?
            .text()
            .await
            .map_err(to_string_err)?;
        // Response is {"tag": count, ...}
        let map: std::collections::HashMap<String, serde_json::Value> =
            serde_json::from_str(&response).map_err(to_string_err)?;
        let mut tags: Vec<(String, u64)> = map
            .into_iter()
            .map(|(k, v)| {
                let count = v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0);
                (k, count)
            })
            .collect();
        tags.sort_by(|a, b| b.1.cmp(&a.1));
        Ok(tags.into_iter().map(|(t, _)| t).collect())
    }

    pub async fn delete_bookmark(&self, href: &str) -> Result<(), String> {
        let token = self.get_token()?;
        // Call Pinboard delete API
        let response = self
            .client
            .get("https://api.pinboard.in/v1/posts/delete")
            .query(&[("auth_token", token.as_str()), ("url", href), ("format", "json")])
            .send()
            .await
            .map_err(to_string_err)?;
        if !response.status().is_success() && response.status() != StatusCode::NOT_FOUND {
            return Err(format!("Pinboard API error: {}", response.status()));
        }
        // Remove from local DB regardless of API result (may not exist remotely for local-only items)
        let href_norm = normalize_url(href)?;
        let conn = self.conn()?;
        conn.execute("DELETE FROM bookmarks WHERE href_norm = ?1", [&href_norm])
            .map_err(to_string_err)?;
        Ok(())
    }

    async fn check_update(&self) -> Result<bool, String> {
        self.wait_for_rate_limit(true).await?;
        let token = self.get_token()?;
        let url = "https://api.pinboard.in/v1/posts/update";
        let response = self
            .client
            .get(url)
            .query(&[
                ("auth_token", token.as_str()),
                ("format", "json"),
            ])
            .send()
            .await
            .map_err(to_string_err)?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            self.apply_backoff(60)?;
            return Err("Rate limited by Pinboard API".to_string());
        }
        let value: serde_json::Value = response.json().await.map_err(to_string_err)?;
        let parsed: Result<UpdateResponse, _> = serde_json::from_value(value.clone());
        let update_time = parsed
            .ok()
            .and_then(|u| u.update_time.or(u.time))
            .or_else(|| value.get("update_time").and_then(|x| x.as_str()).map(ToOwned::to_owned))
            .or_else(|| value.get("time").and_then(|x| x.as_str()).map(ToOwned::to_owned))
            .unwrap_or_default();
        self.mark_rate_success(true)?;
        let conn = self.conn()?;
        let previous: Option<String> = conn
            .query_row("SELECT last_update_time FROM sync_state WHERE id=1", [], |row| row.get(0))
            .map_err(to_string_err)?;
        if previous.as_deref() != Some(update_time.as_str()) {
            conn.execute(
                "UPDATE sync_state SET last_update_time=?1 WHERE id=1",
                params![update_time],
            )
            .map_err(to_string_err)?;
            return Ok(true);
        }
        Ok(false)
    }

    async fn pull_recent(&self) -> Result<(), String> {
        self.wait_for_rate_limit(true).await?;
        let token = self.get_token()?;
        // posts/all returns every bookmark as a bare JSON array
        let response = self
            .client
            .get("https://api.pinboard.in/v1/posts/all")
            .query(&[("auth_token", token.as_str()), ("format", "json")])
            .send()
            .await
            .map_err(to_string_err)?;

        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            self.apply_backoff(60)?;
            return Err("Rate limited by Pinboard API".to_string());
        }
        let posts: Vec<RecentPost> = response.json().await
            .map_err(|_| "Failed to parse posts/all response".to_string())?;
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction().map_err(to_string_err)?;
        for post in posts {
            let href_norm = normalize_url(&post.href)?;
            tx.execute(
                "INSERT OR REPLACE INTO bookmarks
                 (href_norm, href, title, tags, time_remote, source, pending_write_id, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'remote', NULL, ?6)",
                params![
                    href_norm,
                    post.href,
                    post.description,
                    post.tag,
                    post.time,
                    now_epoch()
                ],
            )
            .map_err(to_string_err)?;
        }
        tx.execute(
            "UPDATE sync_state
             SET last_sync_epoch=?1, last_error=NULL
             WHERE id=1",
            params![now_epoch()],
        )
        .map_err(to_string_err)?;
        tx.commit().map_err(to_string_err)?;
        self.mark_rate_success(true)?;
        Ok(())
    }

    pub async fn flush_pending_writes(&self) -> Result<(), String> {
        if !self.has_token() {
            return Ok(());
        }
        loop {
            let maybe_item = self.next_pending_write()?;
            let item = match maybe_item {
                Some(x) => x,
                None => break,
            };
            self.wait_for_rate_limit(false).await?;
            let token = self.get_token()?;
            let url = "https://api.pinboard.in/v1/posts/add";
            let response = self
                .client
                .get(url)
                .query(&[
                    ("auth_token", token.as_str()),
                    ("format", "json"),
                    ("url", item.href.as_str()),
                    ("description", item.title.as_str()),
                    ("tags", item.tags.as_str()),
                    ("replace", "yes"),
                ])
                .send()
                .await
                .map_err(to_string_err)?;
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                self.mark_retry(&item.id, "429 rate limited")?;
                self.apply_backoff(3)?;
                continue;
            }

            let parsed: Result<AddResult, _> = response.json().await.map_err(to_string_err);
            match parsed {
                Ok(result) if result.result_code.as_deref() == Some("done") => {
                    self.mark_write_success(&item.id)?;
                    self.mark_rate_success(false)?;
                }
                Ok(result) => {
                    self.mark_write_permanent_failure(
                        &item.id,
                        format!("add failed: {:?}", result.result_code).as_str(),
                    )?;
                }
                Err(err) => {
                    self.mark_retry(&item.id, &err)?;
                }
            }
        }
        Ok(())
    }

    fn next_pending_write(&self) -> Result<Option<PendingWrite>, String> {
        let conn = self.conn()?;
        let now = now_epoch();
        let mut stmt = conn
            .prepare(
                "SELECT id, href, title, tags
                 FROM pending_writes
                 WHERE status IN ('queued', 'retry_wait')
                   AND next_attempt_at <= ?1
                 ORDER BY created_at ASC
                 LIMIT 1",
            )
            .map_err(to_string_err)?;
        let mut rows = stmt.query(params![now]).map_err(to_string_err)?;
        if let Some(row) = rows.next().map_err(to_string_err)? {
                let item = PendingWrite {
                    id: row.get(0).map_err(to_string_err)?,
                    href: row.get(1).map_err(to_string_err)?,
                    title: row.get(2).map_err(to_string_err)?,
                    tags: row.get(3).map_err(to_string_err)?,
                };
            conn.execute(
                "UPDATE pending_writes SET status='sending' WHERE id=?1",
                params![item.id],
            )
            .map_err(to_string_err)?;
            return Ok(Some(item));
        }
        Ok(None)
    }

    fn mark_write_success(&self, id: &str) -> Result<(), String> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE pending_writes SET status='succeeded', last_error=NULL WHERE id=?1",
            params![id],
        )
        .map_err(to_string_err)?;
        conn.execute(
            "UPDATE bookmarks
             SET source='remote', pending_write_id=NULL
             WHERE pending_write_id=?1",
            params![id],
        )
        .map_err(to_string_err)?;
        Ok(())
    }

    fn mark_write_permanent_failure(&self, id: &str, message: &str) -> Result<(), String> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE pending_writes
             SET status='failed_permanent', last_error=?2
             WHERE id=?1",
            params![id, message],
        )
        .map_err(to_string_err)?;
        conn.execute(
            "UPDATE bookmarks SET source='failed_pending' WHERE pending_write_id=?1",
            params![id],
        )
        .map_err(to_string_err)?;
        Ok(())
    }

    fn mark_retry(&self, id: &str, message: &str) -> Result<(), String> {
        let conn = self.conn()?;
        let attempts: i64 = conn
            .query_row(
                "SELECT attempt_count FROM pending_writes WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(to_string_err)?;
        let next_attempt = now_epoch() + retry_delay_seconds(attempts);
        if attempts >= 8 {
            self.mark_write_permanent_failure(id, message)?;
            return Ok(());
        }
        conn.execute(
            "UPDATE pending_writes
             SET status='retry_wait',
                 attempt_count=attempt_count + 1,
                 next_attempt_at=?2,
                 last_error=?3
             WHERE id=?1",
            params![id, next_attempt, message],
        )
        .map_err(to_string_err)?;
        Ok(())
    }

    async fn wait_for_rate_limit(&self, recent_endpoint: bool) -> Result<(), String> {
        let conn = self.conn()?;
        let (next_generic_at, next_recent_at, backoff): (i64, i64, i64) = conn
            .query_row(
                "SELECT next_generic_at, next_recent_at, backoff_seconds FROM sync_state WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(to_string_err)?;
        let now = now_epoch();
        let mut wait = (next_generic_at - now).max(0);
        if recent_endpoint {
            wait = wait.max(next_recent_at - now);
        }
        wait = wait.max(backoff);
        if wait > 0 {
            sleep(Duration::from_secs(wait as u64)).await;
        }
        Ok(())
    }

    fn mark_rate_success(&self, recent_endpoint: bool) -> Result<(), String> {
        let conn = self.conn()?;
        let now = now_epoch();
        let next_generic_at = now + 3;
        let next_recent_at = if recent_endpoint { now + 60 } else { now };
        conn.execute(
            "UPDATE sync_state
             SET next_generic_at=?1,
                 next_recent_at=CASE WHEN ?3 = 1 THEN ?2 ELSE next_recent_at END,
                 backoff_seconds=0
             WHERE id=1",
            params![next_generic_at, next_recent_at, if recent_endpoint { 1 } else { 0 }],
        )
        .map_err(to_string_err)?;
        Ok(())
    }

    fn apply_backoff(&self, baseline: i64) -> Result<(), String> {
        let conn = self.conn()?;
        let current: i64 = conn
            .query_row("SELECT backoff_seconds FROM sync_state WHERE id=1", [], |row| row.get(0))
            .map_err(to_string_err)?;
        let next = next_backoff_seconds(current, baseline);
        conn.execute(
            "UPDATE sync_state
             SET backoff_seconds=?1,
                 last_error='Rate limited by Pinboard API'
             WHERE id=1",
            params![next],
        )
        .map_err(to_string_err)?;
        Ok(())
    }

    fn get_token(&self) -> Result<String, String> {
        self.token_cache
            .lock()
            .map_err(to_string_err)?
            .clone()
            .ok_or_else(|| "No API token set".to_string())
    }

    pub async fn fetch_page_meta(&self, url: &str) -> Result<PageMeta, String> {
        let url = if url.contains("://") { url.to_string() } else { format!("https://{}", url) };
        let parsed = Url::parse(&url).map_err(to_string_err)?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("Only http/https URLs are allowed".to_string());
        }
        let host = parsed
            .host_str()
            .ok_or_else(|| "URL must include a host".to_string())?;
        if is_blocked_host(host) {
            return Err("Refusing local/private host for metadata fetch".to_string());
        }
        let html = self.client
            .get(parsed)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
            .map_err(to_string_err)?
            .text()
            .await
            .map_err(to_string_err)?;

        let title = extract_title(&html);
        let tags = extract_tags(&html);
        Ok(PageMeta { title, tags })
    }

    fn conn(&self) -> Result<Connection, String> {
        Connection::open(&self.db_path).map_err(to_string_err)
    }
}

fn is_blocked_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.is_unspecified()
        }
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
        }
        Err(_) => false,
    }
}

#[derive(Debug)]
struct PendingWrite {
    id: String,
    href: String,
    title: String,
    tags: String,
}

fn now_epoch() -> i64 {
    Utc::now().timestamp()
}

fn to_string_err<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

pub fn normalize_url(input: &str) -> Result<String, String> {
    let mut url = Url::parse(input.trim()).map_err(to_string_err)?;
    let _ = url.set_scheme(&url.scheme().to_lowercase());
    if let Some(host) = url.host_str() {
        let _ = url.set_host(Some(&host.to_lowercase()));
    }
    match (url.scheme(), url.port()) {
        ("http", Some(80)) | ("https", Some(443)) => {
            let _ = url.set_port(None);
        }
        _ => {}
    }
    url.set_fragment(None);
    if url.path() != "/" && url.path().ends_with('/') {
        let trimmed = url.path().trim_end_matches('/').to_string();
        url.set_path(&trimmed);
    }
    Ok(url.to_string())
}

pub fn dedupe_key(url: &str, title: &str, created_at: DateTime<Utc>) -> Result<String, String> {
    let normalized = normalize_url(url)?;
    let minute_bucket = created_at.format("%Y-%m-%dT%H:%M").to_string();
    let payload = format!("{}|{}|{}", normalized, title.trim().to_lowercase(), minute_bucket);
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

fn retry_delay_seconds(attempts: i64) -> i64 {
    3_i64 * 2_i64.pow((attempts as u32).min(5))
}

fn next_backoff_seconds(current: i64, baseline: i64) -> i64 {
    if current <= 0 {
        baseline
    } else {
        (current * 2).min(300)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_url_strips_fragment_and_default_port() {
        let normalized = normalize_url("https://Example.com:443/a/b/#hello").unwrap();
        assert_eq!(normalized, "https://example.com/a/b");
    }

    #[test]
    fn normalize_url_keeps_query() {
        let normalized = normalize_url("https://example.com/a/?x=1&y=2#frag").unwrap();
        assert_eq!(normalized, "https://example.com/a?x=1&y=2");
    }

    #[test]
    fn dedupe_key_stable_for_same_minute() {
        let ts = DateTime::parse_from_rfc3339("2026-03-18T10:22:05Z")
            .unwrap()
            .with_timezone(&Utc);
        let one = dedupe_key("https://example.com/", "A Title", ts).unwrap();
        let two = dedupe_key("https://example.com", "A Title", ts).unwrap();
        assert_eq!(one, two);
    }

    #[test]
    fn retry_delay_caps_growth() {
        assert_eq!(retry_delay_seconds(0), 3);
        assert_eq!(retry_delay_seconds(1), 6);
        assert_eq!(retry_delay_seconds(5), 96);
        assert_eq!(retry_delay_seconds(8), 96);
    }

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(next_backoff_seconds(0, 3), 3);
        assert_eq!(next_backoff_seconds(3, 3), 6);
        assert_eq!(next_backoff_seconds(200, 3), 300);
    }

    #[test]
    fn blocks_local_hosts_for_meta_fetch() {
        assert!(is_blocked_host("localhost"));
        assert!(is_blocked_host("127.0.0.1"));
        assert!(is_blocked_host("10.0.0.1"));
        assert!(!is_blocked_host("example.com"));
    }
}
