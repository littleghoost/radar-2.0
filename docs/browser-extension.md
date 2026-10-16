# Extensão Radar 2.0 Bridge

Bridge 0.4.0 para Opera GX e navegadores Chromium com Manifest V3. O Desktop precisa estar aberto ou executando em segundo plano. Toda importação é enviada ao serviço local em `http://127.0.0.1:3130`.

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

## Novidades da Bridge 0.4.0

- Perfis de Mercari, Vinted, Grailed e Poshmark com links de itens individuais.
- **Sites e buscas com sua conta** no popup: o usuário pode conceder acesso HTTPS somente ao site desejado, salvar até 20 URLs de resultados com nome, radar e intervalo de 1h a 7 dias, e removê-las quando necessário.
- O Auto-Browse inclui essas buscas salvas, suspende fontes que peçam login ou verificação e permite reabrir a aba para continuar manualmente. Não automatiza autenticação, CAPTCHA ou restrições.
- Permissões opcionais HTTPS são solicitadas no navegador ao ativar cada novo domínio, e os content scripts são registrados apenas para sites concedidos.
- Em sites sem perfil específico, o coletor exige links com formato de anúncio individual, evitando categorias e páginas de pesquisa.
- Testes de regressão adicionais verificam limites de permissão, agendamento, deduplicação das buscas salvas e filtros de link.

A atualização do código não equivale à atualização da extensão carregada no navegador: recarregue-a em `opera://extensions` ou `chrome://extensions` após a instalação da versão de desenvolvimento.

### Verificações com páginas reais (16/10/2026)

Em um perfil temporário do Edge, fora da sessão do Opera GX, o coletor extraiu links individuais no Mercari JP (15), Vinted FR (96) e Poshmark (8 inicialmente, 15 após rolagem). O Mercari carrega imagens tardiamente; a rolagem recuperou imagens visíveis, mas o site virtualiza cards e pode descartar os anteriores do DOM. A Bridge passou a acumular os cards durante até quatro rolagens limitadas, guardando a foto quando for carregada. No Grailed a página apresentou verificação de segurança e não houve coleta; agora isso é indicado como `verification_required`, sem tentativa de contorno.

Testamos também a instalação isolada da extensão no Edge: o popup da versão 0.4.0 carregou com os controles de sites e buscas salvas. **Ainda são necessários testes manuais com permissões concedidas e sessões autenticadas no navegador habitual** antes de declarar compatibilidade completa com todas as plataformas. A página de teste e o banco da instalação Windows são mantidos separados.
