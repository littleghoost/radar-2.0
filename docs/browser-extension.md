# Extensão Radar 2.0 Bridge

O Browser Bridge manual continua disponível como fallback, mas a extensão Chromium elimina o passo de copiar/colar JSON.

## Arquitetura

```text
aba ativa do marketplace
        ↓ (clique do usuário)
Radar 2.0 Bridge
        ↓
collector.js lê cards já renderizados
        ↓
preview no popup
        ↓
POST http://127.0.0.1:3130/api/import/assisted
        ↓
deduplicação → IA visual → preferência → Grail Score
```

A extensão é Manifest V3 e usa somente `activeTab`, `scripting` e `storage`. O `host_permissions` é limitado ao backend local do Radar.

## Compatibilidade

- Opera GX / Chromium
- Google Chrome / Chromium
- navegadores Chromium com suporte a Manifest V3 e `chrome.scripting`

## Segurança

A extensão não contém credenciais de marketplaces. A leitura da página só ocorre após ação explícita do usuário. Não há background scraping, bypass de anti-bot nem acesso a cookies/senhas.
