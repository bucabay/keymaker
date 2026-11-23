// The GUI has no console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The human surface.
//!
//! Everything here is a thin wrapper over `keymaker_core::gui`, which holds the
//! logic and the tests. This file exists to turn those into Tauri commands.
//!
//! Each command builds its own store, manifest and audit log rather than
//! holding them open. A GUI is not a hot path, and per-command construction
//! means a secret saved from the CLI shows up here without a restart.

use keymaker_core::audit::Log;
use keymaker_core::clock::SystemClock;
use keymaker_core::approvals::Approvals;
use keymaker_core::clock::Clock;
use keymaker_core::gui::{
    ApprovalRow, AuditRow, BiometricStatus, EndpointRow, Gui, Health, RefRow, TaskRow,
};
use keymaker_core::id::OsEntropy;
use keymaker_core::manifest::Manifest;
use keymaker_core::provider::Catalog;
use keymaker_core::runner::{ProcessSpawner, Runner};
use keymaker_core::store::{platform_store, SecretStore, UnlockedVault};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

/// The vault session, if one is open. Held for the life of the window so one
/// authorization serves every reveal until the app closes.
struct VaultState(Mutex<Option<UnlockedVault>>);

/// `SystemClock` holds nothing, so one can live for the whole program and be
/// borrowed by every audit log.
static CLOCK: SystemClock = SystemClock;

/// Likewise: entropy holds nothing, so one can be borrowed for the whole run.
static ENTROPY: OsEntropy = OsEntropy;

/// The queue the broker and this window share. A person is the slow part of
/// the loop, so the GUI polls it rather than anything being pushed.
fn approval_queue() -> Approvals<'static> {
    Approvals::new(config_dir().join("approvals.json"), &CLOCK, &ENTROPY)
}

fn config_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    if cfg!(target_os = "macos") {
        PathBuf::from(home).join("Library/Application Support/keymaker")
    } else {
        PathBuf::from(home).join(".config/keymaker")
    }
}

fn manifest_path() -> PathBuf {
    std::env::var("KEYMAKER_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(".keymaker"))
}

fn load_manifest() -> Manifest {
    std::fs::read_to_string(manifest_path())
        .ok()
        .and_then(|src| Manifest::from_toml(&src).ok())
        .unwrap_or_else(|| Manifest::from_toml("version = 1").expect("empty manifest is valid"))
}

fn load_catalog() -> Catalog {
    for p in [
        PathBuf::from(".keymaker.endpoints.toml"),
        config_dir().join("endpoints.toml"),
    ] {
        if let Ok(src) = std::fs::read_to_string(&p) {
            if let Ok(c) = Catalog::from_toml(&src) {
                return c;
            }
        }
    }
    Catalog::default()
}

/// Build everything a command needs, run `body`, and hand back the result.
fn with_gui<T>(body: impl FnOnce(&mut Gui) -> Result<T, String>) -> Result<T, String> {
    let mut store: Box<dyn SecretStore> = platform_store();
    let audit_path = config_dir().join("audit.jsonl");
    let audit = Log::open(&CLOCK, &audit_path).map_err(|e| e.to_string())?;
    let mut gui = Gui::new(store.as_mut(), load_manifest(), load_catalog(), audit);
    body(&mut gui)
}

#[tauri::command]
fn list_refs() -> Result<Vec<RefRow>, String> {
    with_gui(|g| Ok(g.refs()))
}

/// The one place in the whole project that returns a value.
///
/// It is reachable only from a window a person is looking at, and it is
/// recorded in the same audit chain as everything else. When the vault is
/// open the read is silent; otherwise the item's own access control prompts.
#[tauri::command]
fn reveal(reference: String, state: tauri::State<VaultState>) -> Result<String, String> {
    let slot = state.0.lock().map_err(|_| "vault state is busy".to_string())?;
    with_gui(|g| match &*slot {
        Some(vault) => g.reveal_unlocked(&reference, vault).map_err(|e| e.to_string()),
        None => g.reveal(&reference).map_err(|e| e.to_string()),
    })
}

/// Whether a vault key exists on this machine.
#[tauri::command]
fn vault_ready() -> Result<bool, String> {
    with_gui(|g| g.vault_ready().map_err(|e| e.to_string()))
}

/// Whether this build can protect items at all, and whether a vault exists.
/// A capability query: nothing is read and nothing is unlocked here.
#[tauri::command]
fn biometric_status() -> Result<BiometricStatus, String> {
    with_gui(|g| Ok(g.biometrics()))
}

/// One authorization opens every protected value. Returns whether a vault
/// was opened: false means there is no vault key yet, not that anything
/// failed. Held until the app closes.
#[tauri::command]
fn unlock_vault(state: tauri::State<VaultState>) -> Result<bool, String> {
    let mut slot = state.0.lock().map_err(|_| "vault state is busy".to_string())?;
    if slot.is_some() {
        return Ok(true);
    }
    with_gui(|g| {
        let opened = g.unlock_vault().map_err(|e| e.to_string())?;
        let ready = opened.is_some();
        *slot = opened;
        Ok(ready)
    })
}

#[tauri::command]
fn enable_biometrics(reference: String) -> Result<(), String> {
    with_gui(|g| g.enable_biometrics(&reference).map_err(|e| e.to_string()))
}

#[tauri::command]
fn save_secret(reference: String, value: String) -> Result<(), String> {
    with_gui(|g| g.save(&reference, &value).map_err(|e| e.to_string()))
}

#[tauri::command]
fn delete_secret(reference: String) -> Result<(), String> {
    with_gui(|g| g.delete(&reference).map_err(|e| e.to_string()))
}

#[tauri::command]
fn list_tasks() -> Result<Vec<TaskRow>, String> {
    with_gui(|g| Ok(g.tasks()))
}

#[tauri::command]
fn list_endpoints() -> Result<Vec<EndpointRow>, String> {
    with_gui(|g| Ok(g.endpoints()))
}

#[tauri::command]
fn list_environments() -> Result<Vec<String>, String> {
    with_gui(|g| Ok(g.environments()))
}

#[tauri::command]
fn audit_rows() -> Result<Vec<AuditRow>, String> {
    with_gui(|g| Ok(g.audit_rows()))
}

/// What is waiting for a person right now.
#[tauri::command]
fn pending_approvals() -> Result<Vec<ApprovalRow>, String> {
    let queue = approval_queue();
    with_gui(|g| Ok(g.approvals(&queue, CLOCK.now())))
}

/// Answer one. The broker picks the answer up on the agent's next attempt.
#[tauri::command]
fn decide_approval(id: String, granted: bool) -> Result<(), String> {
    let queue = approval_queue();
    with_gui(|g| g.decide(&queue, &id, granted).map_err(|e| e.to_string()))
}

#[tauri::command]
fn health() -> Result<Health, String> {
    with_gui(|g| Ok(g.health()))
}

#[derive(Serialize)]
struct RunResult {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    redacted: bool,
    leaked_files: Vec<String>,
}

/// Run a task from the GUI. Output comes back redacted, exactly as it would
/// for an agent — a person watching a task run has no more need to see the
/// credential than the agent does.
#[tauri::command]
fn run_task(task: String, env: String) -> Result<RunResult, String> {
    let store = platform_store();
    let spawner = ProcessSpawner;
    let manifest = load_manifest();
    let runner = Runner::new(store.as_ref(), &spawner).watching_defaults();
    let out = runner
        .run_task(&manifest, &task, &env)
        .map_err(|e| e.to_string())?;
    Ok(RunResult {
        exit_code: out.exit_code,
        stdout: out.stdout_string(),
        stderr: out.stderr_string(),
        redacted: out.redacted,
        leaked_files: out
            .files_with_values
            .iter()
            .map(|p| p.display().to_string())
            .collect(),
    })
}

fn main() {
    tauri::Builder::default()
        .manage(VaultState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            list_refs,
            reveal,
            vault_ready,
            biometric_status,
            unlock_vault,
            enable_biometrics,
            save_secret,
            delete_secret,
            list_tasks,
            list_endpoints,
            list_environments,
            audit_rows,
            health,
            run_task,
            pending_approvals,
            decide_approval,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start keymaker");
}
