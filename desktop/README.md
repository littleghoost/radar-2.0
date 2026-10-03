# Radar 2.0 Desktop

Aplicativo desktop do Radar usando Tauri 2.

## Estado atual

O app agora empacota o backend Node.js como um **sidecar nativo**. A instalação final não precisa de WSL nem de Node.js para iniciar o Radar. O sidecar sobe o mesmo backend Express na porta local `3130`, e a janela Tauri abre a interface web existente.

O SQLite do desktop fica no diretório de dados do aplicativo. No Windows:

`%APPDATA%\com.littleghoost.radar2\radar-desktop.db`

O processo auxiliar é encerrado junto com a janela do Radar.

## Build Windows

Pré-requisitos de desenvolvimento: Rust/MSVC, WebView2 e Node.js. Na raiz do projeto, instale as dependências do backend; depois, em `desktop/`:

```bash
npm install
npm run build:sidecar
npm run tauri build
```

Ou use:

```bash
npm run build:desktop
```

`build:sidecar` usa `@yao-pkg/pkg` para gerar `src-tauri/binaries/radar-backend-<target>.exe`. O Tauri inclui esse executável automaticamente no instalador por `bundle.externalBin`.

## Próximas fases

- ícone próprio e identidade visual do Radar;
- tray e execução em segundo plano;
- notificações nativas para novos achados/queda de preço;
- iniciar com o Windows;
- scheduler local chamando `runDueRadars`;
- sincronização opcional com o servidor.

## Modo em segundo plano

O Desktop mantém o Radar ativo ao fechar a janela: o clique no X oculta a interface e deixa o processo no system tray. O menu do tray permite abrir o Radar, rodar os radares imediatamente ou sair de verdade.

O scheduler local consulta os radares preparados a cada 5 minutos e chama `POST /api/scheduler/run-due`. Quando uma execução cria novos anúncios, quedas de preço ou alertas importantes, o app dispara uma notificação nativa do Windows.

## Configurações do modo background

A página **Perfil** agora inclui um painel do Radar Desktop com:

- iniciar com o Windows;
- ativar/desativar o monitoramento em segundo plano;
- intervalo de verificação dos agendamentos (5, 15, 30 ou 60 minutos);
- filtros para notificações de novos anúncios, quedas de preço e falhas;
- opção de iniciar minimizado no tray quando o Windows abrir o app.

As preferências ficam salvas no SQLite local do desktop. O autostart usa o plugin oficial `tauri-plugin-autostart` e é sincronizado pelo processo desktop; o app só registra a inicialização automática quando a opção estiver ligada.
