use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::WebviewWindowBuilder,
    Manager, State, WebviewUrl, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

struct AppState {
    backend: Mutex<Option<CommandChild>>,
    quitting: AtomicBool,
}

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

fn stop_backend(state: State<'_, AppState>) {
    if let Ok(mut guard) = state.backend.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

fn http_json(method: &str, path: &str, body: Option<&str>) -> Result<Value, String> {
    let mut stream = TcpStream::connect_timeout(
        &"127.0.0.1:3130".parse().unwrap(),
        Duration::from_secs(2),
    )
    .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;

    let payload = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:3130\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        payload.as_bytes().len(),
        payload
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "resposta HTTP inválida".to_string())?;

    if !head.contains(" 200 ") {
        return Err(format!("HTTP inesperado: {}", head.lines().next().unwrap_or(head)));
    }

    serde_json::from_str(body).map_err(|error| error.to_string())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn run_due_once(app: &tauri::AppHandle, notify: bool) {
    let before = http_json("GET", "/api/notifications/summary", None).ok();
    let _ = http_json("POST", "/api/scheduler/run-due", Some("{\"limit\":5}"));
    let after = http_json("GET", "/api/notifications/summary", None).ok();

    if !notify {
        return;
    }

    let previous = before
        .as_ref()
        .and_then(|value| value.get("unseen_total"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let current = after
        .as_ref()
        .and_then(|value| value.get("unseen_total"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    if current <= previous {
        return;
    }

    let data = after.unwrap_or(Value::Null);
    let new_listings = data.get("new_listings").and_then(Value::as_i64).unwrap_or(0);
    let price_drops = data.get("price_drops").and_then(Value::as_i64).unwrap_or(0);
    let errors = data.get("errors").and_then(Value::as_i64).unwrap_or(0);

    let mut parts = Vec::new();
    if new_listings > 0 {
        parts.push(format!("{new_listings} novo(s) anúncio(s)"));
    }
    if price_drops > 0 {
        parts.push(format!("{price_drops} queda(s) de preço"));
    }
    if errors > 0 {
        parts.push(format!("{errors} alerta(s) de fonte"));
    }

    let body = if parts.is_empty() {
        "O Radar encontrou atividade nova.".to_string()
    } else {
        parts.join(" • ")
    };

    let _ = app
        .notification()
        .builder()
        .title("Radar 2.0 encontrou novidades")
        .body(body)
        .show();
}

fn start_scheduler(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(8));
        while running.load(Ordering::Relaxed) {
            run_due_once(&app, true);
            for _ in 0..60 {
                if !running.load(Ordering::Relaxed) {
                    return;
                }
                thread::sleep(Duration::from_secs(5));
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    const PORT: u16 = 3130;
    let scheduler_running = Arc::new(AtomicBool::new(true));
    let scheduler_for_exit = scheduler_running.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            backend: Mutex::new(None),
            quitting: AtomicBool::new(false),
        })
        .setup(move |app| {
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
                        CommandEvent::Stdout(bytes) => {
                            eprintln!("[radar-backend] {}", String::from_utf8_lossy(&bytes))
                        }
                        CommandEvent::Stderr(bytes) => eprintln!(
                            "[radar-backend:error] {}",
                            String::from_utf8_lossy(&bytes)
                        ),
                        CommandEvent::Error(error) => eprintln!("[radar-backend:error] {error}"),
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[radar-backend] encerrado: {:?}", payload.code)
                        }
                        _ => {}
                    }
                }
            });

            if let Ok(mut guard) = app.state::<AppState>().backend.lock() {
                *guard = Some(child);
            }

            if !wait_for_backend(PORT, Duration::from_secs(15)) {
                stop_backend(app.state::<AppState>());
                return Err("o backend empacotado do Radar não respondeu na porta 3130".into());
            }

            let url = format!("http://127.0.0.1:{PORT}").parse().unwrap();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Radar 2.0")
                .inner_size(1280.0, 820.0)
                .min_inner_size(980.0, 640.0)
                .build()?;

            let open_item = MenuItem::with_id(app, "open", "Abrir Radar", true, None::<&str>)?;
            let run_item = MenuItem::with_id(app, "run_now", "Rodar radares agora", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Sair do Radar", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &run_item, &quit_item])?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Radar 2.0 • monitoramento ativo")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "run_now" => {
                        let app = app.clone();
                        thread::spawn(move || run_due_once(&app, true));
                    }
                    "quit" => {
                        app.state::<AppState>().quitting.store(true, Ordering::Relaxed);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;

            start_scheduler(app.handle().clone(), scheduler_running.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao inicializar o Radar 2.0 Desktop")
        .run(move |app, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" && !app.state::<AppState>().quitting.load(Ordering::Relaxed) => {
                api.prevent_close();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                scheduler_for_exit.store(false, Ordering::Relaxed);
                stop_backend(app.state::<AppState>());
            }
            _ => {}
        });
}
