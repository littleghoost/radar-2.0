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

O MVP desktop em Tauri 2 fica em `desktop/`. O backend Node.js já é empacotado como sidecar nativo, então a instalação do Windows pode rodar sem WSL e sem Node.js. O app usa um SQLite próprio em `%APPDATA%\com.littleghoost.radar2\radar-desktop.db`, inicia o backend local na porta 3130 e encerra o processo auxiliar ao fechar a janela.

## Radar por imagem

Radares podem receber uma imagem JPEG/PNG de referência. O motor combina comparação perceptual clássica com **IA visual semântica CLIP local** no app desktop, além de palavras-chave e preço. Cada anúncio pode ter `visual_score`, `semantic_score` e `hybrid_score` de 0 a 100. A versão desktop empacota o modelo semântico para funcionar sem depender de uma API externa de IA. Veja `docs/visual-radar.md`.
