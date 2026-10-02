# Integrações do Radar 2.0

Estado das fontes pesquisadas para o Radar. A regra do projeto é usar APIs e fluxos autorizados; quando uma plataforma não oferece busca pública, o adapter deve ficar desativado em vez de tentar contornar bloqueios.

## eBay

- Adapter de Browse API preparado.
- Aguardando liberação/credenciais de produção.
- Variáveis: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_MARKETPLACE_ID`.
- É a fonte mais promissora para busca geral assim que o acesso estiver liberado.

## Mercado Livre

- OAuth oficial funcionando.
- Refresh token automático implementado.
- Busca geral `/sites/MLB/search` retorna 403 para o aplicativo atual.
- Importação oficial por item também pode retornar 403 conforme as políticas de acesso.
- Não tentar contornar o bloqueio; manter conexão para endpoints autorizados.

## OLX

- Adapter de estado preparado em `server/services/sources/olx.js`.
- Integração oficial depende de homologação/credenciais.
- Variáveis reservadas: `OLX_CLIENT_ID`, `OLX_CLIENT_SECRET`, `OLX_REDIRECT_URI`.
- Até a homologação, a fonte retorna `pending_homologation` e não participa da coleta.

## Depop

- Adapter de estado preparado em `server/services/sources/depop.js`.
- A Selling API oficial é privada e requer contato/aprovação da Depop.
- OAuth 2.0 usa Authorization Code + PKCE para integrações de terceiros.
- A API documentada é voltada a produtos do próprio vendedor, pedidos, ofertas e loja; não há endpoint oficial de busca geral do marketplace documentado.
- Por isso, Depop não entra em `searchAllSources` neste momento.
- Variáveis reservadas: `DEPOP_CLIENT_ID`, `DEPOP_CLIENT_SECRET`, `DEPOP_REDIRECT_URI`.

## Vinted

- Existe Vinted Pro Integrations API, mas o acesso é allowlist e voltado a empresas Pro.
- A documentação pública cobre gestão do próprio inventário, webhooks e pedidos, não busca geral do marketplace.
- Não implementar como fonte de busca do Radar sem um endpoint oficial adequado.

## Enjoei

- Não foi localizada uma API pública oficial de busca de marketplace na pesquisa atual.
- Manter como candidato para integração futura via app desktop/importação assistida, respeitando os controles e termos da plataforma.

## Estratégia para app desktop

Fontes sem API de busca pública devem ficar separadas das fontes de servidor. No futuro, o app desktop poderá oferecer fluxos assistidos pelo usuário e importação de links, enquanto `radarRunner` continua sendo o motor comum de normalização, histórico e eventos.
