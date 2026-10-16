# Extensão Radar 2.0 Bridge

Bridge 0.4.0 para Opera GX e navegadores Chromium com Manifest V3. Compatível com Desktop 0.2.9. O Desktop precisa estar aberto ou executando em segundo plano. Toda importação é enviada ao serviço local em `http://127.0.0.1:3130`.

## Sites e buscas com sua conta

No popup, abra **Sites e buscas com sua conta**. Entre no marketplace normalmente, configure os filtros na página de resultados e clique em **Ativar coleta neste site**. A solicitação de acesso vale apenas para o domínio daquela página. Para repetir a página, escolha o radar de destino, dê um nome à busca e clique em **Salvar busca desta página**. O intervalo vai de uma hora a sete dias; o padrão é quatro horas. Ative Auto-Browse para executar as buscas salvas. Até vinte páginas podem ser salvas; elas mantêm os filtros e a ordenação do endereço, mesmo sem uma API pública ou indexação em buscadores.

Há reconhecimento de cards de Mercari EUA/Japão (incluindo JPY), Vinted, Grailed e Poshmark, além das plataformas anteriores. Em outros sites HTTPS, a captura genérica exige foto, título e preço em um card com um único anúncio do mesmo site. A captura manual pode ser experimentada antes de autorizar coleta persistente. A extração genérica depende do layout e não garante compatibilidade com todos os sites.

As buscas usam o mesmo perfil e sessão já abertos no navegador. A extensão não lê nem exporta cookies ou senhas. Ao detectar login ou verificação, mantém a página de trabalho, preserva a busca e pausa aquela fonte. No painel, use **Abrir página pendente**, conclua a etapa pessoalmente e depois **Continuar**. Outras fontes da fila podem continuar. O painel permite remover buscas ou desativar a coleta do site.

No Mercado Livre, a coleta pelo navegador funciona independentemente da busca por API e não exige token OAuth. Links de catálogo só são tratados como anúncio quando trazem a identificação da oferta individual. Usar a Bridge não altera o acesso concedido pelo Mercado Livre à API.

## Modos de captura

- **Manual:** abra uma página de marketplace, escolha o radar, analise os cards e confirme o envio no popup.
- **Auto-Capture:** ligado por padrão e controlado pelo popup. Lê cards carregados em páginas visíveis das plataformas declaradas no manifesto, sem abrir abas. Envia para a Inbox com organização automática por radar. Reconhece alterações de título, preço e foto; uma página sem mudanças não é enviada repetidamente. Falhas temporárias usam novas tentativas com intervalo de 15 a 60 segundos, respeitando a opção desligada e a visibilidade da aba.
- **Auto-Browse beta:** desligado por padrão. Quando ativado, usa o Search Planner para abrir buscas em uma janela de trabalho minimizada, com alternativa de aba inativa. Fecha a janela/aba que criou após a captura. A fila é preservada quando o Desktop está offline, há falha temporária de importação ou o usuário cancela uma busca. Desligar Auto-Browse limpa a fila.

Os resultados passam pela validação de cards, deduplicação, análise visual, regras e Grail Score do backend. O envio manual mostra novos, atualizados, duplicados, inválidos e falhas.

## Permissões e privacidade

O manifesto declara `activeTab`, `scripting`, `storage`, `notifications` e `alarms`. Há permissões de host para o serviço local e os domínios de OLX, Enjoei, Mercado Livre/Libre, Depop, eBay e Facebook Marketplace. Esses acessos permitem o coletor automático e o Auto-Browse; o acesso às páginas não se limita ao clique manual.

A extensão não solicita cookies, senhas ou armazenamento dos marketplaces. Não faz login, não resolve CAPTCHA e não contorna HTTP 403 ou bloqueios. `storage` guarda opções, buscas salvas, domínios escolhidos, fila e resumo das capturas da extensão. Os hosts adicionais são opcionais e solicitados individualmente; não há concessão automática a todos os sites. URLs de autenticação e endereços contendo credenciais não podem ser salvos como busca. Notificações resumem novos anúncios e quedas de preço. O Facebook usa principalmente Auto-Capture enquanto o usuário navega, por depender da sessão e da visibilidade.

## Verificação

`npm test` inclui regressões de alterações de metadados, imagens lazy-loaded, recuperação offline, cancelamento, buscas salvas, permissões e retomada da mesma sessão após login. `npm run test:collector-fixtures` prepara uma página local com catorze cenários de DOM, incluindo sites novos, oferta individual do Mercado Livre, login e verificação, sem enviar anúncios ao catálogo. A extração continua heurística e deve ser reavaliada quando um marketplace altera seu layout.
