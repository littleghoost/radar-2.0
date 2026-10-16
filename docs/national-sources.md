# Fontes brasileiras e filtro por origem — Desktop 0.2.11 / Bridge 0.4.2

## Feed
- **Todas as origens:** lista o catálogo inteiro.
- **Brasil:** país BR informado no cadastro ou marketplace brasileiro conhecido (OLX, Enjoei, Mercado Livre .com.br, Repassa, eBrecho).
- **Internacional:** país diferente de BR informado ou marketplace estrangeiro conhecido (eBay, Mercari, Grailed, Vinted etc.).
- **Origem a confirmar:** a plataforma e os metadados não demonstram a origem (Facebook Marketplace, Shopee e sites genéricos sem país do item).
- O filtro **Site** usa a plataforma exata e pode ser combinado com radar, status, pesquisa e origem.

A procedência indicada por marketplace é **presumida**; anúncios do Mercado Livre brasileiro podem ter envio internacional. Mesmo em BRL, a origem de um anúncio eBay pode ser estrangeira. A informação `item_country` conhecida tem prioridade sobre todos os outros sinais. Passe o mouse sobre a etiqueta BRASIL/EXTERIOR/A CONFIRMAR para ver a fonte da classificação. Os dados anteriores não são modificados nem migrados.

## Fontes
- Captura pré-existente: OLX, Enjoei, Mercado Livre, Facebook Marketplace.
- Adições à Bridge 0.4.2: Shopee (links `/product/<loja>/<item>` e `-i.<loja>.<item>`), Repassa (`/produtos/<produto>`).
- eBrecho: perfil nomeado com filtro conservador de URLs genéricas; **captura experimental e não validada em páginas reais**.
- Em Conexões há atalhos para abrir essas sete fontes; um atalho não automatiza navegação nem concede acesso à extensão. Ative o site manualmente na Bridge e salve pesquisas relevantes.
- O catálogo só inclui URLs de anúncios individuais, e a plataforma pode mudar HTML ou exigir login/CAPTCHA. Não tentamos contornar essas proteções.

## Versões, validação e privacidade
- Desktop 0.2.11 contém a API e a interface dos filtros; é necessário instalar um novo executável/sidecar para que o filtro funcione no app Windows.
- A Bridge 0.4.1 é recarregada pelo Opera GX e não substitui o Desktop.
- `node --test tests/listingRegion.test.js tests/browserSavedSites.test.js`, `npm test` e integração API executados em banco de teste.
- A base SQLite de produção fica intacta, sem reclassificação persistente dos registros.


## Validação adicional em navegador (16/10/2026)
- **eBrecho:** extração real de 40 anúncios individuais com imagens. Não foram importados para a base de produção.
- **Repassa:** o endereço antigo `/prod` atualmente leva a 404; a loja atual usa `/store` e os produtos `/store/product/<id>/<slug>`. Atualizado o atalho e o reconhecedor; pesquisa/captura em cards reais ainda não validada.
- **Shopee:** em navegador isolado respondeu com `/verify/traffic/error`. A Bridge detecta e pausa; não contorna proteção. O usuário pode realizar captura pela sua sessão normal, se o site permitir.
