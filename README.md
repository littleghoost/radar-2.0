# Radar 2.0 — MVP 0.1

Radar pessoal para organizar garimpos de roupas, câmeras e outros anúncios.

## Estado atual

- Dashboard com radares e feed de anúncios.
- SQLite persistente.
- Deploy no Fly.io em `ord` (Chicago).
- HTTPS público.
- OAuth oficial do Mercado Livre conectado.
- Renovação automática do access token do Mercado Livre.
- Histórico de preços e prevenção de URLs duplicadas.
- Importação manual de anúncios por link preparada para APIs autorizadas.
- Health check em `/api/health`.
- Histórico de execuções e atividade.
- Motor de radar desacoplado das rotas HTTP.
- Agendamento preparado por radar, sem worker 24/7 ativo no Fly.

## Desenvolvimento local

Requisitos: Node.js 22+ e npm.

```bash
npm install
npm start
```

Abra `http://localhost:3000`.

## Variáveis de ambiente

Veja `.env.example`. Credenciais reais nunca devem ser commitadas.

## Produção

O deploy usa:

- `Dockerfile`
- `fly.toml`
- volume Fly `radar_data` em `/data`
- `DB_PATH=/data/radar.db`

URL atual: `https://radar-2-0-littleghoost.fly.dev`

## Mercado Livre

O OAuth usa Authorization Code + Refresh Token. O callback configurado é:

```text
https://radar-2-0-littleghoost.fly.dev/auth/mercadolivre/callback
```

A conta conectada é identificada pelo backend e o token é renovado próximo do vencimento.

A API oficial atualmente retorna 403 para busca geral por palavra-chave neste aplicativo. O Radar não tenta contornar essa restrição. Integrações de coleta automática devem usar somente endpoints/fontes autorizados.

## Próximas etapas

- autenticação própria do Radar antes de uso multiusuário;
- adapters por fonte em `server/services/sources/`;
- ligar o worker periódico quando houver servidor/app desktop disponível;
- alertas de preço e disponibilidade;
- score visual para peças/câmeras;
- integração com outras plataformas via APIs autorizadas.

## Desktop

O MVP desktop em Tauri 2 fica em `desktop/`. No Windows de desenvolvimento ele inicia o backend local pelo WSL na porta 3130 e abre a interface do Radar em uma janela nativa. O banco desktop usa `data/radar-desktop.db`. A fase seguinte é empacotar o backend como sidecar para remover a dependência de WSL na instalação final.
