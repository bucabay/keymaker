//! Per-item protection in the macOS Data Protection Keychain, plus a vault so
//! one authorization can open every protected item.
//!
//! Two layers:
//!
//! - Every protected item's access control accepts either USER_PRESENCE (Touch
//!   ID or the device password, one prompt per read) or the
//!   APPLICATION_PASSWORD. That password is a random vault key created once
//!   per service, itself stored under a USER_PRESENCE access control.
//! - [`unlock`] reads the vault key — one authorization — and attaches it to
//!   an authentication context. Every read through that context is silent, so
//!   the GUI prompts once no matter how many values a person looks at.
//!
//! No separate LocalAuthentication preflight: SecItemCopyMatching performs
//! authorization and returns the value in one operation. No values are
//! cached. Nothing here works without a signed, provisioned app bundle; an
//! unsigned build is refused with a missing-entitlement error, which callers
//! use to fall back to the standard keychain.
#![cfg(target_os = "macos")]

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::{CFData, CFDataRef};
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2_foundation::NSData;
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
use security_framework::passwords::{
    delete_generic_password_options, generic_password, set_generic_password_options,
    AccessControlOptions, PasswordOptions,
};
use security_framework_sys::item::{
    kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword, kSecReturnData,
    kSecUseAuthenticationContext, kSecUseAuthenticationUI, kSecUseAuthenticationUISkip,
};
use security_framework_sys::keychain_item::SecItemCopyMatching;
use std::sync::OnceLock;

#[link(name = "LocalAuthentication", kind = "framework")]
extern "C" {}

/// `LACredentialTypeApplicationPassword` from LocalAuthentication.
const CREDENTIAL_TYPE_APPLICATION_PASSWORD: isize = 0;

/// Account name the vault key lives under, in the `{service}.vault` service so
/// name listings of the real service never include it.
const VAULT_ACCOUNT: &str = "__vault__";

const NOT_FOUND: i32 = -25300;
const MISSING_ENTITLEMENT: i32 = -34018;

fn error(e: security_framework::base::Error) -> String {
    match e.code() {
        MISSING_ENTITLEMENT => "Biometric item access requires a signed, provisioned app bundle with keychain-access-groups entitlements. Protected-item access was refused. See docs/BIOMETRICS.md.".into(),
        -128 | -25293 => "Keychain authorization was cancelled or denied".into(),
        code => format!("Protected keychain operation failed (macOS status {})", code),
    }
}

fn options(service: &str, account: &str) -> PasswordOptions {
    let mut options = PasswordOptions::new_generic_password(service, account);
    options.use_protected_keychain();
    options
}

fn vault_service(service: &str) -> String {
    format!("{service}.vault")
}

fn random_key() -> Result<[u8; 32], String> {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("reading /dev/urandom: {}", e))?;
    Ok(bytes)
}

/// Attributes only: listing protected items never authenticates or reads data.
/// Builds without provisioning can use the caller's standard-keychain backend.
pub fn names(service: &str) -> Result<Vec<String>, String> {
    let result = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service)
        .ignore_legacy_keychains()
        .load_attributes(true)
        .load_data(false)
        .limit(Limit::All)
        .search();
    match result {
        Ok(items) => Ok(items
            .into_iter()
            .filter_map(|item| item.simplify_dict()?.remove("acct"))
            .collect()),
        Err(e) if e.code() == NOT_FOUND || e.code() == MISSING_ENTITLEMENT => Ok(Vec::new()),
        Err(e) => Err(error(e)),
    }
}

pub fn contains(service: &str, account: &str) -> Result<bool, String> {
    Ok(names(service)?.iter().any(|name| name == account))
}

/// Check signing/entitlements without requesting a password first.
pub fn ensure_available() -> Result<(), String> {
    if available()? {
        Ok(())
    } else {
        Err(error(security_framework::base::Error::from_code(
            MISSING_ENTITLEMENT,
        )))
    }
}

/// Whether this process may use the Data Protection Keychain.
///
/// A search cannot tell an unprovisioned build from an empty keychain: both
/// answer NOT_FOUND. The first operation macOS refuses is a write carrying an
/// access control, so probe with one and remove it. The answer cannot change
/// during the life of the process, so it is asked once.
pub fn available() -> Result<bool, String> {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    if let Some(known) = AVAILABLE.get() {
        return Ok(*known);
    }

    let service = "seal-biometric-entitlement-check";
    let account = "__probe__";
    let access = SecAccessControl::create_with_protection(
        Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
        AccessControlOptions::USER_PRESENCE.bits(),
    )
    .map_err(error)?;
    let mut options = PasswordOptions::new_generic_password(service, account);
    options.use_protected_keychain();
    options.set_access_control(access);
    let available = match set_generic_password_options(b"probe", options) {
        Ok(()) => {
            let mut cleanup = PasswordOptions::new_generic_password(service, account);
            cleanup.use_protected_keychain();
            let _ = delete_generic_password_options(cleanup);
            true
        }
        Err(e) if e.code() == MISSING_ENTITLEMENT => false,
        Err(e) => return Err(error(e)),
    };
    let _ = AVAILABLE.set(available);
    Ok(available)
}

/// Whether a returned error message is the missing-entitlement refusal: the
/// process cannot use the protected keychain at all (an unsigned or
/// unprovisioned build). Callers fall back to the standard keychain on this
/// and only this, so no other failure silently downgrades where a value rests.
pub fn is_missing_entitlement(message: &str) -> bool {
    message
        == error(security_framework::base::Error::from_code(
            MISSING_ENTITLEMENT,
        ))
}

/// Whether the vault key for `service` exists.
pub fn vault_exists(service: &str) -> Result<bool, String> {
    contains(&vault_service(service), VAULT_ACCOUNT)
}

/// Create the vault key if there is not one already. Creating it needs no
/// authorization: only reading it does. Called before the first protected
/// item is written, so every protected item can later be unlocked together.
pub fn setup_vault(service: &str) -> Result<(), String> {
    if vault_exists(service)? {
        return Ok(());
    }
    let access = SecAccessControl::create_with_protection(
        Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
        AccessControlOptions::USER_PRESENCE.bits() | AccessControlOptions::DEVICE_PASSCODE.bits(),
    )
    .map_err(error)?;
    let mut options = PasswordOptions::new_generic_password(&vault_service(service), VAULT_ACCOUNT);
    options.set_access_control(access);
    set_generic_password_options(&random_key()?, options).map_err(error)
}

/// Read the vault key. Its USER_PRESENCE access control makes macOS offer
/// Touch ID with the device-password fallback — the one authorization the
/// whole vault costs. The bytes are the credential: hand them to
/// [`get_with_key`] for reads that never prompt again.
pub fn unlock(service: &str) -> Result<Vec<u8>, String> {
    generic_password(options(&vault_service(service), VAULT_ACCOUNT)).map_err(|e| {
        if e.code() == NOT_FOUND {
            "There is no vault key yet; enable biometric protection on an item first.".to_string()
        } else {
            error(e)
        }
    })
}

/// Read a protected item under an unlocked vault key. No prompt: a fresh
/// authentication context carries the credential on the calling thread, so
/// the key itself is the only state that ever needs sharing.
pub fn get_with_key(service: &str, account: &str, key: &[u8]) -> Result<String, String> {
    let context: Retained<AnyObject> = unsafe {
        let class = AnyClass::get(c"LAContext").ok_or("LAContext is unavailable on this system")?;
        msg_send![class, new]
    };
    let credential = NSData::with_bytes(key);
    let accepted: Bool = unsafe {
        msg_send![&context, setCredential: &*credential, type: CREDENTIAL_TYPE_APPLICATION_PASSWORD]
    };
    if !accepted.as_bool() {
        return Err("The authentication context refused the vault key".to_string());
    }
    let service_cf = CFString::from(service);
    let account_cf = CFString::from(account);
    unsafe {
        let ctx: CFTypeRef = (&*context as *const AnyObject).cast();
        let keys: [CFTypeRef; 6] = [
            kSecClass.cast(),
            kSecAttrService.cast(),
            kSecAttrAccount.cast(),
            kSecReturnData.cast(),
            kSecUseAuthenticationContext.cast(),
            kSecUseAuthenticationUI.cast(),
        ];
        let values: [CFTypeRef; 6] = [
            kSecClassGenericPassword.cast(),
            service_cf.as_CFTypeRef(),
            account_cf.as_CFTypeRef(),
            CFBoolean::true_value().as_CFTypeRef(),
            ctx,
            kSecUseAuthenticationUISkip.cast(),
        ];
        let pairs: Vec<(CFType, CFType)> = keys
            .iter()
            .copied()
            .zip(values.iter().copied())
            .map(|(k, v)| {
                (
                    CFType::wrap_under_get_rule(k),
                    CFType::wrap_under_get_rule(v),
                )
            })
            .collect();
        let query = CFDictionary::from_CFType_pairs(&pairs);
        let mut result: CFTypeRef = std::ptr::null();
        let status = SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result);
        if status != 0 {
            return Err(error(security_framework::base::Error::from_code(status)));
        }
        if result.is_null() {
            return Err("Keychain returned no data".to_string());
        }
        let data = CFData::wrap_under_create_rule(result as CFDataRef);
        String::from_utf8(data.bytes().to_vec()).map_err(|_| "Keychain value is not UTF-8".into())
    }
}

/// Read exactly once. The item's USER_PRESENCE access control lets macOS
/// offer Touch ID, with the device password fallback. Cancellation is never
/// a legacy fallback. Reading through an [`Unlock`] is preferred: this path
/// prompts once per item.
pub fn get(service: &str, account: &str) -> Result<String, String> {
    let bytes = generic_password(options(service, account)).map_err(error)?;
    String::from_utf8(bytes).map_err(|_| "Keychain value is not UTF-8".into())
}

pub fn set(service: &str, account: &str, value: &str) -> Result<(), String> {
    let mut options = options(service, account);
    if !contains(service, account)? {
        // USER_PRESENCE keeps a direct read prompting per item as a fallback;
        // APPLICATION_PASSWORD lets one unlock() authorize every read.
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            AccessControlOptions::USER_PRESENCE.bits()
                | AccessControlOptions::APPLICATION_PASSWORD.bits(),
        )
        .map_err(error)?;
        options.set_access_control(access);
    }
    // Existing items update their value without replacing their ACL or reading
    // the old password. New items receive the policy above.
    set_generic_password_options(value.as_bytes(), options).map_err(error)
}

pub fn delete(service: &str, account: &str) -> Result<(), String> {
    delete_generic_password_options(options(service, account)).map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entitlement_and_cancellation_errors_are_actionable() {
        assert!(error(security_framework::base::Error::from_code(
            MISSING_ENTITLEMENT
        ))
        .contains("signed, provisioned app bundle"));
        assert!(error(security_framework::base::Error::from_code(-128)).contains("cancelled"));
    }

    #[test]
    fn the_missing_entitlement_message_is_exactly_detectable() {
        let message = error(security_framework::base::Error::from_code(
            MISSING_ENTITLEMENT,
        ));
        assert!(is_missing_entitlement(&message));
        assert!(!is_missing_entitlement(
            "Keychain authorization was cancelled or denied"
        ));
    }

    #[test]
    fn vault_services_do_not_collide_with_the_plain_service() {
        assert_eq!(vault_service("keymaker"), "keymaker.vault");
    }

    #[test]
    #[ignore = "requires a signed test binary and interactive Touch ID/password approval"]
    fn protected_item_round_trip() {
        let service = "seal-biometric-selftest";
        let account = format!("test-{}", std::process::id());
        set(service, &account, "test value\n").unwrap();
        assert!(contains(service, &account).unwrap());
        assert_eq!(get(service, &account).unwrap(), "test value\n");
        delete(service, &account).unwrap();
        assert!(!contains(service, &account).unwrap());
    }

    #[test]
    #[ignore = "requires a signed test binary and interactive Touch ID/password approval"]
    fn one_unlock_authorizes_every_protected_item() {
        let service = "seal-biometric-selftest";
        let one = format!("one-{}", std::process::id());
        let two = format!("two-{}", std::process::id());
        setup_vault(service).unwrap();
        assert!(vault_exists(service).unwrap());
        set(service, &one, "first").unwrap();
        set(service, &two, "second").unwrap();
        let key = unlock(service).unwrap();
        // Both reads are silent: the one authorization covers the vault.
        assert_eq!(get_with_key(service, &one, &key).unwrap(), "first");
        assert_eq!(get_with_key(service, &two, &key).unwrap(), "second");
        delete(service, &one).unwrap();
        delete(service, &two).unwrap();
    }
}
