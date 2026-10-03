use std::{
    net::{TcpStream, ToSocketAddrs},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{webview::WebviewWindowBuilder, Manager, State, WebviewUrl};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};

struct BackendProcess(Mutex<Option<CommandChild>>);

fn wait_for_backend(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let address = ("127.0.0.1", port)
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

fn stop_backend(state: State<'_, BackendProcess>) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    const PORT: u16 = 3130;

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let db_path = app_data.join("radar-desktop.db");

            let sidecar = app
                .shell()
                .sidecar("radar-backend")?
                .env("PORT", PORT.to_string())
                .env("DB_PATH", db_path.to_string_lossy().to_string());

            let (mut events, child) = sidecar.spawn()?;
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => eprintln!("[radar-backend] {}", String::from_utf8_lossy(&bytes)),
                        CommandEvent::Stderr(bytes) => eprintln!("[radar-backend:error] {}", String::from_utf8_lossy(&bytes)),
                        CommandEvent::Error(error) => eprintln!("[radar-backend:error] {error}"),
                        CommandEvent::Terminated(payload) => eprintln!("[radar-backend] encerrado: {:?}", payload.code),
                        _ => {}
                    }
                }
            });
            if let Ok(mut guard) = app.state::<BackendProcess>().0.lock() {
                *guard = Some(child);
            }

            if !wait_for_backend(PORT, Duration::from_secs(15)) {
                stop_backend(app.state::<BackendProcess>());
                return Err("o backend empacotado do Radar não respondeu na porta 3130".into());
            }

            let url = format!("http://127.0.0.1:{PORT}").parse().unwrap();
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
