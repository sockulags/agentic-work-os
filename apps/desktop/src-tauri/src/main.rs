#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri shell for the Agentic Work OS harness.
//!
//! Deliberately thin. All the real work happens in the Node core (`packages/core`); this
//! process spawns it, learns the port and token from its ready line, and hands them to
//! the WebView. Everything after that is a WebSocket conversation the Rust side never
//! sees.
//!
//! Keeping the shell this small is what makes the core debuggable in a plain browser:
//! `npm run dev` reaches exactly the same daemon over exactly the same protocol.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// The single line the core prints on stdout once it is listening.
/// Its shape is a contract — see `packages/core/src/main.ts`.
#[derive(Debug, Deserialize)]
struct ReadyLine {
    host: String,
    port: u16,
    token: String,
}

/// Handle to the core process, so shutdown can be clean.
struct CoreProcess(Mutex<Option<Child>>);

impl CoreProcess {
    /// Orphaned agent processes would keep running against the user's repository, so
    /// this runs on window close and again on drop. Killing twice is harmless.
    fn shutdown(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *guard = None;
        }
    }
}

impl Drop for CoreProcess {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Locate the compiled core: the workspace copy during development, the bundled
/// resource in a packaged build.
fn core_entrypoint(app: &tauri::AppHandle) -> PathBuf {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/core/dist/main.js");
    if dev_path.exists() {
        return dev_path;
    }

    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("core/main.js");
        if bundled.exists() {
            return bundled;
        }
    }

    dev_path
}

/// Start the core and block until it reports a port and token.
fn start_core(app: &tauri::AppHandle) -> Result<(Child, ReadyLine), String> {
    let entry = core_entrypoint(app);

    if !entry.exists() {
        return Err(format!(
            "harness core not found at {}. Run `npm run build` first.",
            entry.display()
        ));
    }

    let mut child = Command::new("node")
        .arg(&entry)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| {
            format!(
                "failed to start the harness core ({}): {e}. Is Node on PATH?",
                entry.display()
            )
        })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "harness core produced no stdout".to_string())?;

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();

    // The core prints exactly one line and then goes quiet, so a single read is enough.
    reader.read_line(&mut line).map_err(|e| {
        format!("could not read the harness ready line: {e}")
    })?;

    if line.trim().is_empty() {
        let _ = child.kill();
        return Err("harness core exited before reporting a port".to_string());
    }

    let ready: ReadyLine = serde_json::from_str(line.trim()).map_err(|e| {
        let _ = child.kill();
        format!("unexpected ready line from the harness core: {e} (got: {line})")
    })?;

    Ok((child, ready))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let (child, ready) = start_core(&handle)?;
            app.manage(CoreProcess(Mutex::new(Some(child))));

            // Connection details are injected as a global rather than pushed through
            // Tauri IPC, so the UI reads them the same way in a browser during
            // `npm run dev`. See resolveClientOptions() in apps/ui/src/lib/client.ts.
            let script = format!(
                "window.__AWOS__ = {};",
                serde_json::json!({
                    "host": ready.host,
                    "port": ready.port,
                    "token": ready.token,
                })
            );

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Agentic Work OS")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(&script)
                .build()?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                if let Some(core) = window.app_handle().try_state::<CoreProcess>() {
                    core.shutdown();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to start the desktop shell");
}
