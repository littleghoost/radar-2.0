# Radar 2.0 Bridge 0.4.2 (desenvolvimento)

Extensão Manifest V3 para Opera GX, Chrome e outros navegadores Chromium.
Envia metadados de anúncios individuais para o Radar Desktop em
`http://127.0.0.1:3130`. Não é a extensão **Media Grabber Universal**, que
cuida dos downloads de vídeos.

## Instalação e atualização

1. Inicie o Radar Desktop.
2. Abra `opera://extensions` (ou `chrome://extensions`) e ative o modo desenvolvedor.
3. Carregue a pasta `extension` deste repositório como extensão sem compactação.
4. Se já estiver instalada, use **Recarregar** após salvar uma atualização.
5. Fixe a Bridge na barra do navegador.

Esta versão é de desenvolvimento. Não há garantia de publicação automática na loja.

## Capturar páginas

- **Manual:** abra uma busca, escolha o radar, clique em **Analisar página atual**
  e confirme o envio. A importação mostra novos, atualizados e falhas.
- **Auto-Capture:** ligado por padrão. Observa apenas cards de anúncios carregados
  nas abas visíveis autorizadas e envia mudanças de título, preço ou imagem.
- **Auto-Browse beta:** desligado por padrão. Quando ligado, lê o Search Planner
  e as buscas salvas, usando uma janela de trabalho minimizada ou aba inativa.
  Em caso de login/verificação, a fonte fica pausada até ação do usuário.

Fontes com suporte explícito: OLX, Enjoei, Mercado Livre, Mercado Libre,
Depop, eBay, Facebook Marketplace, Mercari, Vinted, Grailed Poshmark, Shopee e Repassa; eBrecho via captura conservadora.
A Shopee pode incluir vendedores estrangeiros: o local do anúncio só é confirmado
quando a plataforma informa o país. A captura não garante frete nacional.
A coleta em novos sites usa heurísticas conservadoras de URLs de anúncios e
pode precisar de ajustes. O Facebook costuma depender de aba visível e sessão.

## Salvar uma busca com sua própria sessão

1. Entre normalmente no marketplace no seu navegador (não forneça credenciais à Bridge).
2. Ajuste a página de resultados: termos, preço, categoria, filtros.
3. No popup, expanda **Sites e buscas com sua conta**.
4. Clique em **Ativar coleta neste site** e autorize apenas o domínio mostrado
   pelo navegador. Para as fontes já autorizadas, prossiga.
5. Digite um nome para a busca, selecione o radar e o intervalo (1h, 4h,
   12h ou 1 dia), então clique em **Salvar busca desta página**.
6. Habilite o Auto-Browse para repetir buscas automaticamente.

São permitidas até 20 buscas salvas. A fila preserva tentativas pendentes
quando o Desktop está offline. A busca salva registra a URL de resultados,
não credenciais. Desativar a coleta em um site também remove as buscas desse
site. Em fontes com autenticação, a sessão pode expirar ou ser bloqueada;
a Bridge não faz login automático, não resolve CAPTCHA nem contorna 403.

## Permissões, privacidade e limitações

- O manifesto solicita permissões fixas para fontes conhecidas e permissões
  opcionais HTTPS por site adicional, concedidas pelo próprio usuário.
- Usa `activeTab`, `scripting`, `storage`, `notifications` e `alarms`.
  Scripts automáticos podem ler cards visíveis nos sites autorizados.
- Não solicita cookies, senhas ou armazenamento interno do marketplace.
- A comunicação do Radar fica em `127.0.0.1:3130`.
- Sites genéricos só são capturados se os links se parecem com anúncios
  individuais, para evitar guardar páginas de busca e categoria.
- Cada marketplace pode modificar o HTML e exigir revisão do coletor.

## Verificação do código

- `npm test` testa backend, filas, captura, permissões e buscas salvas.
- `npm run test:collector-fixtures` inicia fixtures locais do coletor
  para inspeção em um navegador Chromium.
- Os testes unitários não substituem validação em marketplaces reais.
