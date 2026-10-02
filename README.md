# Radar 2.0 — MVP 0.1

Primeira versão local do nosso Radar.

## O que já faz

- Criar radares com palavras-chave, categoria e preço máximo.
- Adicionar anúncios manualmente.
- Salvar link direto, plataforma, imagem, preço e observações.
- Evitar anúncios duplicados pela URL.
- Marcar como:
  - novo
  - interessante
  - descartado
  - vendido
- Atualizar preço.
- Guardar histórico de preço.
- Mostrar quando o preço caiu.
- Filtrar por radar, status e texto.
- Banco local SQLite em `data/radar.db`.

## Requisitos

- Node.js 18 ou superior
- npm

## Como instalar no Windows

1. Extraia a pasta `radar-2.0`.
2. Abra a pasta no VS Code.
3. Abra o terminal dentro dela.
4. Rode:

```bash
npm install
```

5. Depois:

```bash
npm start
```

6. Abra:

```text
http://localhost:3000
```

## Primeiros radares sugeridos

### Radar de roupas

Nome:
`Grails / JNCO`

Busca:
`JNCO baggy kangaroo vintage tribal dragon embroidery`

Preço máximo:
`150`

Categoria:
`roupas`

### Radar de Handycam

Nome:
`Handycam NightShot`

Busca:
`Sony Handycam NightShot HDD DCR-SR`

Preço máximo:
`300`

Categoria:
`cameras`

## Próxima fase

A versão 0.2 será focada em coleta automática de anúncios.

Arquitetura prevista:

```text
server/
└── services/
    └── sources/
        ├── olx.js
        ├── enjoei.js
        ├── mercadolivre.js
        ├── ebay.js
        └── mercari.js
```

Fluxo:

```text
fonte -> coletor -> normalizador -> filtro -> banco -> feed
```

Depois entram:

- detecção automática de anúncio repetido;
- alertas de preço;
- score visual;
- filtros separados para roupa e câmera;
- imagem/análise por IA;
- execução periódica;
- notificações.

## Observação

Alguns marketplaces bloqueiam scraping automatizado ou exigem APIs próprias.
Por isso a integração será feita fonte por fonte, escolhendo o método mais estável e permitido.
