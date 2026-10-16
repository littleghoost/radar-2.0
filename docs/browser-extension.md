# Extensão Radar 2.0 Bridge

Bridge 0.3.12 para Opera GX e navegadores Chromium com Manifest V3. O Desktop precisa estar aberto ou executando em segundo plano. Toda importação é enviada ao serviço local em `http://127.0.0.1:3130`.

## Modos de captura

- **Manual:** abra uma página de marketplace, escolha o radar, analise os cards e confirme o envio no popup.
- **Auto-Capture:** ligado por padrão e controlado pelo popup. Lê cards carregados em páginas visíveis das plataformas declaradas no manifesto, sem abrir abas. Envia para a Inbox com organização automática por radar. Reconhece alterações de título, preço e foto; uma página sem mudanças não é enviada repetidamente. Falhas temporárias usam novas tentativas com intervalo de 15 a 60 segundos, respeitando a opção desligada e a visibilidade da aba.
- **Auto-Browse beta:** desligado por padrão. Quando ativado, usa o Search Planner para abrir buscas em uma janela de trabalho minimizada, com alternativa de aba inativa. Fecha a janela/aba que criou após a captura. A fila é preservada quando o Desktop está offline, há falha temporária de importação ou o usuário cancela uma busca. Desligar Auto-Browse limpa a fila.

Os resultados passam pela validação de cards, deduplicação, análise visual, regras e Grail Score do backend. O envio manual mostra novos, atualizados, duplicados, inválidos e falhas.

## Permissões e privacidade

O manifesto declara `activeTab`, `scripting`, `storage`, `notifications` e `alarms`. Há permissões de host para o serviço local e os domínios de OLX, Enjoei, Mercado Livre/Libre, Depop, eBay e Facebook Marketplace. Esses acessos permitem o coletor automático e o Auto-Browse; o acesso às páginas não se limita ao clique manual.

A extensão não solicita cookies, senhas ou armazenamento dos marketplaces. Não faz login, não resolve CAPTCHA e não contorna HTTP 403 ou bloqueios. `storage` guarda opções, fila e resumo das capturas da extensão. Notificações resumem novos anúncios e quedas de preço. O Facebook usa principalmente Auto-Capture enquanto o usuário navega, por depender da sessão e da visibilidade.

## Verificação

`npm test` inclui regressões de alterações de metadados, imagens lazy-loaded, recuperação offline, cancelamento e persistência da fila. `npm run test:collector-fixtures` prepara uma página local de fixtures para conferir DOM e extração em seis plataformas sem enviar anúncios ao catálogo. A extração continua heurística e deve ser reavaliada quando um marketplace altera seu layout.
