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
use std::time::Duration;

use serde::Deserialize;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_updater::UpdaterExt;

/// Long enough that startup stays the fastest thing the app does.
const FIRST_UPDATE_CHECK: Duration = Duration::from_secs(30);
/// A harness session runs for hours; four hours between checks is plenty.
const UPDATE_RECHECK: Duration = Duration::from_secs(4 * 60 * 60);

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

/// Strip Windows' verbatim `\\?\` prefix from a path.
///
/// `resource_dir()` returns a verbatim path. Rust and the filesystem accept it happily, so
/// `exists()` says yes and the spawn succeeds — and then Node reads `\\?\C:\...` as a UNC
/// share, resolves the script argument down to `C:`, and dies on an EISDIR before it ever
/// loads the core. Nothing in the dev loop goes through `resource_dir()`, so this only
/// ever surfaces in a packaged build.
fn without_verbatim_prefix(path: PathBuf) -> PathBuf {
    match path.to_string_lossy().strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped),
        None => path,
    }
}

/// Locate the compiled core: the workspace copy during development, the bundled
/// resource in a packaged build.
fn core_entrypoint(app: &tauri::AppHandle) -> PathBuf {
    // The bundled copy wins. `CARGO_MANIFEST_DIR` is baked in at compile time, so on the
    // machine that built the installer that path still exists — checking it first would
    // make an installed app quietly run the developer's working tree instead of its own.
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = without_verbatim_prefix(resources.join("core").join("main.js"));
        if bundled.exists() {
            return bundled;
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/core/dist/main.js")
}

/// Locate the Node runtime: the vendored copy in a packaged build, PATH in development.
///
/// A packaged app cannot assume Node is installed, so `scripts/bundle-core.mjs` ships one
/// inside the bundled core. Development deliberately keeps using PATH — a contributor
/// already has a Node, and the dev loop should not depend on a downloaded runtime.
fn node_binary(app: &tauri::AppHandle) -> PathBuf {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    if let Ok(resources) = app.path().resource_dir() {
        let vendored = without_verbatim_prefix(resources.join("core").join("runtime").join(exe));
        if vendored.exists() {
            return vendored;
        }
    }
    PathBuf::from("node")
}

/// Keep Windows from opening a console for the core.
///
/// The release build is a GUI subsystem binary, so spawning a console application would
/// otherwise pop a black window that outlives the spawn and never goes away. It never
/// shows up in `npm run desktop`, because the dev build already owns a console.
fn without_console(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
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

    let node = node_binary(app);
    let mut command = Command::new(&node);
    let mut child = without_console(&mut command)
        .arg(&entry)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| {
            format!(
                "failed to start the harness core ({}) with {}: {e}",
                entry.display(),
                node.display()
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

/// An update that finished downloading, held until the app exits.
///
/// Installing the moment a download lands would restart the app out from under a running
/// agent turn, so the installer is deliberately deferred: the harness stays put until the
/// user closes it themselves.
struct PendingUpdate(Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>);

/// Check quietly on a schedule, starting once startup is out of the way.
///
/// A plain thread rather than an async task: the loop sleeps for hours at a time, and this
/// keeps the shell from taking a direct tokio dependency for two sleeps.
fn watch_for_updates(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_UPDATE_CHECK);
        loop {
            tauri::async_runtime::block_on(fetch_update(&app));
            std::thread::sleep(UPDATE_RECHECK);
        }
    });
}

/// Download a newer version if one is published.
///
/// Every failure ends as a log line. A flaky network, an unreachable release feed or a
/// malformed manifest must never surface to the user: the app they already have works.
async fn fetch_update(app: &tauri::AppHandle) {
    let Some(pending) = app.try_state::<PendingUpdate>() else {
        return;
    };
    // One download is enough; the next check would only re-fetch the same installer.
    if pending.0.lock().map(|held| held.is_some()).unwrap_or(true) {
        return;
    }

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => return eprintln!("[updater] unavailable: {error}"),
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return,
        Err(error) => return eprintln!("[updater] check failed: {error}"),
    };

    let version = update.version.clone();
    match update.download(|_chunk, _total| {}, || {}).await {
        Ok(bytes) => {
            eprintln!("[updater] {version} downloaded; it installs when this window closes");
            if let Ok(mut held) = pending.0.lock() {
                *held = Some((update, bytes));
            }
        }
        Err(error) => eprintln!("[updater] download of {version} failed: {error}"),
    }
}

/// Run a downloaded installer on the way out, if there is one.
fn install_pending_update(app: &tauri::AppHandle) {
    let Some(pending) = app.try_state::<PendingUpdate>() else {
        return;
    };
    let Ok(mut held) = pending.0.lock() else {
        return;
    };
    let Some((update, bytes)) = held.take() else {
        return;
    };
    if let Err(error) = update.install(bytes) {
        eprintln!("[updater] install failed: {error}");
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let (child, ready) = start_core(&handle)?;
            app.manage(CoreProcess(Mutex::new(Some(child))));
            app.manage(PendingUpdate(Mutex::new(None)));
            watch_for_updates(handle.clone());

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
        .build(tauri::generate_context!())
        .expect("failed to start the desktop shell");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            install_pending_update(handle);
        }
    });
}
