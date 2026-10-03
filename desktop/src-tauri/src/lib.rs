use std::{
    net::{TcpStream, ToSocketAddrs},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{webview::WebviewWindowBuilder, Manager, State, WebviewUrl};

struct BackendProcess(Mutex<Option<Child>>);

fn wait_for_backend(host: &str, port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let address = (host, port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next());

    let Some(address) = address else {
        return false;
    };

    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, Duration::from_millis(350)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }

    false
}

#[cfg(target_os = "windows")]
fn spawn_backend(port: u16) -> std::io::Result<Child> {
    let command = format!(
        "(fuser -k {port}/tcp >/dev/null 2>&1 || true); cd /home/little/Projects/radar-2.0 && PORT={port} DB_PATH=/home/little/Projects/radar-2.0/data/radar-desktop.db node server/app.js"
    );

    Command::new("wsl.exe")
        .args(["-e", "bash", "-lc", &command])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

#[cfg(not(target_os = "windows"))]
fn spawn_backend(port: u16) -> std::io::Result<Child> {
    let project_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|desktop| desktop.parent())
        .expect("desktop project must live inside Radar 2.0")
        .to_path_buf();

    Command::new("node")
        .arg("server/app.js")
        .current_dir(&project_root)
        .env("PORT", port.to_string())
        .env("DB_PATH", project_root.join("data/radar-desktop.db"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}


#[cfg(target_os = "windows")]
fn backend_host() -> Result<String, String> {
    let output = Command::new("wsl.exe")
        .args(["-e", "bash", "-lc", "hostname -I | awk '{print $1}'"])
        .output()
        .map_err(|error| format!("não foi possível consultar o IP do WSL: {error}"))?;

    if !output.status.success() {
        return Err("o WSL não respondeu ao consultar o endereço local".into());
    }

    let host = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if host.is_empty() {
        return Err("o WSL não informou um endereço IP".into());
    }

    Ok(host)
}

#[cfg(not(target_os = "windows"))]
fn backend_host() -> Result<String, String> {
    Ok("127.0.0.1".into())
}

fn stop_backend(state: State<'_, BackendProcess>) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    const PORT: u16 = 3130;

    tauri::Builder::default()
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            let child = spawn_backend(PORT).map_err(|error| {
                format!("não foi possível iniciar o backend local do Radar: {error}")
            })?;

            if let Ok(mut guard) = app.state::<BackendProcess>().0.lock() {
                *guard = Some(child);
            }

            let host = backend_host()?;
            if !wait_for_backend(&host, PORT, Duration::from_secs(15)) {
                return Err(format!(
                    "o backend local do Radar não respondeu em http://{host}:{PORT}"
                )
                .into());
            }

            let url = format!("http://{host}:{PORT}").parse().unwrap();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Radar 2.0")
                .inner_size(1280.0, 820.0)
                .min_inner_size(980.0, 640.0)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao inicializar o Radar 2.0 Desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                stop_backend(app.state::<BackendProcess>());
            }
        });
}
