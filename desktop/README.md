# Radar 2.0 Desktop

Primeiro shell desktop do Radar usando Tauri 2.

## Estado atual

O app desktop inicia o backend local do Radar na porta `3130` e abre a interface web existente dentro de uma janela nativa. Nesta primeira fase no Windows, o launcher usa `wsl.exe` para executar o backend que já existe em `/home/little/Projects/radar-2.0`.

O banco desktop é separado do banco de testes local e fica em:

`data/radar-desktop.db`

Isso permite desenvolver o app sem depender do Fly.io para as funções principais.

## Próximas fases

1. Instalar toolchain Tauri/Rust no Windows e gerar a primeira build nativa.
2. Adicionar ícone próprio, tray, notificações nativas e iniciar com o Windows.
3. Empacotar o backend Node como sidecar para remover a dependência de WSL/Node na máquina final.
4. Implementar sincronização opcional com o servidor.
5. Adicionar integrações assistidas locais para fontes sem API pública adequada.

## Desenvolvimento

Dentro da pasta `desktop`:

```bash
npm install
npm run tauri dev
```

Para uma build Windows nativa, o Tauri exige Rust com toolchain MSVC, Microsoft C++ Build Tools e WebView2.
