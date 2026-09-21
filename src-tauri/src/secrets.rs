//! macOS Keychain storage for credentials. Items are bound to the app's code
//! signature, so other apps can't read them without the user approving it.
//! Calls block (and may show a system prompt), so run them off the async runtime.

pub const PINBOARD_SERVICE: &str = "com.trine.pinboarder.pinboard";
pub const JEV_SERVICE: &str = "com.trine.pinboarder.jev";
const ACCOUNT: &str = "api-key";

fn entry(service: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, ACCOUNT).map_err(|e| e.to_string())
}

pub fn read(service: &str) -> Result<Option<String>, String> {
    match entry(service)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain read failed: {e}")),
    }
}

pub fn write(service: &str, secret: &str) -> Result<(), String> {
    entry(service)?
        .set_password(secret)
        .map_err(|e| format!("Keychain write failed: {e}"))
}

pub fn delete(service: &str) -> Result<(), String> {
    match entry(service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Keychain delete failed: {e}")),
    }
}
