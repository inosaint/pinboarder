//! TypeSafe Jev integration.
//!
//! The API key lives only in the macOS Keychain and in this process's memory.
//! It is never returned to the webview: the frontend can set, clear, or ask
//! whether a key exists, and all Jev requests are made from Rust.

use crate::secrets;
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::Mutex;

const JEV_ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const MAX_CANDIDATES: usize = 60;
const MAX_SUGGESTIONS: usize = 5;
const TAG_THRESHOLD: f64 = 0.5;

/// Failure sent to the frontend. `kind` drives the UI:
/// no_key | invalid | limit | rate_limited | offline | error
#[derive(Debug, Serialize)]
pub struct JevFailure {
    pub kind: &'static str,
    pub message: String,
}

impl JevFailure {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

impl From<String> for JevFailure {
    fn from(message: String) -> Self {
        Self::new("error", message)
    }
}

pub struct JevClient {
    client: reqwest::Client,
    // None = keychain not read yet; Some(None) = read, no key stored.
    key_cache: Mutex<Option<Option<String>>>,
}

pub struct PageContext<'a> {
    pub url: &'a str,
    pub title: &'a str,
    pub description: &'a str,
    pub page_keywords: &'a [String],
}

impl JevClient {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            key_cache: Mutex::new(None),
        }
    }

    /// Returns the key, reading the keychain at most once per process. Blocking.
    pub fn key(&self) -> Result<Option<String>, String> {
        let mut cache = self.key_cache.lock().map_err(|e| e.to_string())?;
        if let Some(cached) = cache.as_ref() {
            return Ok(cached.clone());
        }
        let key = secrets::read(secrets::JEV_SERVICE)?;
        *cache = Some(key.clone());
        Ok(key)
    }

    fn cached_key(&self) -> Result<String, JevFailure> {
        let cache = self.key_cache.lock().map_err(|e| e.to_string())?;
        cache
            .clone()
            .flatten()
            .ok_or_else(|| JevFailure::new("no_key", "No Jev key set"))
    }

    /// Verifies the key against the API, then stores it in the keychain.
    pub async fn set_key(&self, key: &str) -> Result<(), JevFailure> {
        let key = key.trim();
        if key.is_empty() {
            return Err(JevFailure::new("invalid", "Key is empty"));
        }
        self.ping(key).await?;
        secrets::write(secrets::JEV_SERVICE, key)?;
        *self.key_cache.lock().map_err(|e| e.to_string())? = Some(Some(key.to_string()));
        Ok(())
    }

    pub fn clear_key(&self) -> Result<(), String> {
        secrets::delete(secrets::JEV_SERVICE)?;
        *self.key_cache.lock().map_err(|e| e.to_string())? = Some(None);
        Ok(())
    }

    /// Handshake: confirms the stored key works and the account has usage left.
    /// Call `key()` first so the keychain has been read.
    pub async fn check(&self) -> Result<(), JevFailure> {
        let key = self.cached_key()?;
        self.ping(&key).await
    }

    /// Picks which of the user's existing tags fit the page, best first.
    /// One yes/no question per candidate tag, all in a single request.
    pub async fn suggest_tags(
        &self,
        page: PageContext<'_>,
        candidates: &[String],
    ) -> Result<Vec<String>, JevFailure> {
        let key = self.cached_key()?;
        let candidates: Vec<&String> = candidates.iter().take(MAX_CANDIDATES).collect();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }

        // Every question is sent separately, so keep them short: the shared
        // tagging rule lives once in state and questions only name the tag.
        let mut questions = Map::new();
        for (i, tag) in candidates.iter().enumerate() {
            questions.insert(
                format!("t{i}"),
                json!({
                    "type": "noul",
                    "instructions": format!("Following `tagging_policy`, should `bookmark` get the tag \"{tag}\"?"),
                }),
            );
        }
        let body = json!({
            "state": {
                "tagging_policy": "The user files Pinboard bookmarks under their own personal tags. \
                    A tag fits only if it clearly describes the page's topic, format, or source, so the user \
                    would expect to find this page under it. Unrelated, loosely related, or stretched tags do not fit.",
                "bookmark": {
                    "url": page.url,
                    "title": page.title,
                    "description": page.description,
                    "page_keywords": page.page_keywords,
                }
            },
            "model": "jev-latest",
            "questions": questions,
        });

        let started = std::time::Instant::now();
        let resp = self.post(&key, &body).await?;
        eprintln!(
            "[pinboarder-jev] suggest_tags candidates={} took={}ms input_tokens={}",
            candidates.len(),
            started.elapsed().as_millis(),
            resp.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0)
        );
        let answers = resp.get("answers").and_then(Value::as_object);
        let mut scored: Vec<(&String, f64)> = candidates
            .iter()
            .enumerate()
            .filter_map(|(i, tag)| {
                let p = answers?.get(&format!("t{i}"))?.get("noul")?.as_f64()?;
                (p >= TAG_THRESHOLD).then_some((*tag, p))
            })
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        Ok(scored
            .into_iter()
            .take(MAX_SUGGESTIONS)
            .map(|(t, _)| t.clone())
            .collect())
    }

    /// Smallest real request, used to validate a key.
    async fn ping(&self, key: &str) -> Result<(), JevFailure> {
        let body = json!({
            "state": "ping",
            "model": "jev-latest",
            "questions": {
                "ok": { "type": "noul", "instructions": "Is this text a short test message?" }
            }
        });
        self.post(key, &body).await.map(|_| ())
    }

    async fn post(&self, key: &str, body: &Value) -> Result<Value, JevFailure> {
        let resp = self
            .client
            .post(JEV_ENDPOINT)
            .bearer_auth(key)
            .json(body)
            .send()
            .await
            .map_err(|_| JevFailure::new("offline", "Couldn't reach TypeSafe"))?;
        let status = resp.status();
        if status.is_success() {
            return resp
                .json::<Value>()
                .await
                .map_err(|_| JevFailure::new("error", "Unexpected response from TypeSafe"));
        }
        let text = resp.text().await.unwrap_or_default().to_lowercase();
        Err(classify_error(status, &text))
    }
}

/// TypeSafe doesn't document a quota-exhausted status, so treat 402 and any
/// 429 whose body talks about credits/billing as "out of usage".
fn classify_error(status: StatusCode, body: &str) -> JevFailure {
    let mentions_billing = ["credit", "quota", "balance", "billing", "payment", "insufficient", "top up"]
        .iter()
        .any(|w| body.contains(w));
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            JevFailure::new("invalid", "TypeSafe rejected this key.")
        }
        StatusCode::PAYMENT_REQUIRED => {
            JevFailure::new("limit", "Jev usage limit reached. Top up your TypeSafe account.")
        }
        StatusCode::TOO_MANY_REQUESTS if mentions_billing => {
            JevFailure::new("limit", "Jev usage limit reached. Top up your TypeSafe account.")
        }
        StatusCode::TOO_MANY_REQUESTS => {
            JevFailure::new("rate_limited", "Jev is busy (rate limited). Try again shortly.")
        }
        s => JevFailure::new("error", format!("TypeSafe returned an error ({}).", s.as_u16())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_errors() {
        assert_eq!(classify_error(StatusCode::UNAUTHORIZED, "").kind, "invalid");
        assert_eq!(classify_error(StatusCode::PAYMENT_REQUIRED, "").kind, "limit");
        assert_eq!(
            classify_error(StatusCode::TOO_MANY_REQUESTS, "{\"error\":\"insufficient credits\"}").kind,
            "limit"
        );
        assert_eq!(
            classify_error(StatusCode::TOO_MANY_REQUESTS, "{\"error\":\"rate limit exceeded\"}").kind,
            "rate_limited"
        );
        assert_eq!(classify_error(StatusCode::BAD_GATEWAY, "").kind, "error");
    }
}
