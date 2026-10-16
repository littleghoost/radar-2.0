# Radar 2.0 Bridge 0.4.0 — extensão Chromium

Extensão Manifest V3 para Chrome/Chromium/Opera GX. Possui captura manual, Auto-Capture em páginas visíveis (ligado por padrão) e Auto-Browse beta (desligado por padrão). Envia anúncios para o Radar Desktop local em `http://127.0.0.1:3130`.

## Instalar no Opera GX

1. Abra `opera://extensions`.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Escolha a pasta `Radar 2.0 Bridge` que acompanha a build de desenvolvimento.
5. Fixe a extensão na barra do navegador se quiser acesso rápido.

No Chrome/Chromium, o processo é equivalente em `chrome://extensions`.

## Uso

1. Deixe o Radar 2.0 Desktop aberto ou no tray.
2. Abra uma página de resultados em OLX, Enjoei, Facebook Marketplace, Depop, eBay ou Mercado Livre. OLX, Enjoei e Facebook usam validação de identidade/card antes do Auto-Capture.
3. Clique no ícone **Radar 2.0 Bridge**.
4. Escolha o radar de destino e clique em **Analisar página atual**.
5. Confira a quantidade detectada e clique em **Enviar para o Radar**.

A extensão lembra o último radar escolhido.

### Sites com conta e buscas salvas

Abra **Sites e buscas com sua conta** no popup. Faça login no marketplace pelo navegador, abra uma busca com os filtros desejados e use **Ativar coleta neste site**. Escolha o radar, nome e intervalo, e clique em **Salvar busca desta página**. Ligue Auto-Browse para repetir as páginas salvas. Login ou CAPTCHA deixam a busca pendente; conclua no site e use **Continuar** na Bridge.

Reconhece também Mercari EUA/Japão, Vinted, Grailed e Poshmark. Outros sites HTTPS têm captura genérica de cards com título, preço, foto e link. O acesso persistente a um novo domínio é opcional e escolhido individualmente. Não é necessário informar senha ou token de marketplace ao Radar. Compatível com Desktop 0.2.9; ao atualizar a extensão, recarregue também as páginas de marketplace já abertas.

### Auto-Browse (beta)

Desligado por padrão. Quando ativado, o Bridge consulta o Search Planner dos radares agendados e processa uma busca por vez em aba inativa. A aba é fechada logo após a captura.

- Câmeras: OLX, Enjoei e Mercado Livre.
- Roupas/geral: OLX, Enjoei, Mercado Livre e Depop.
- Facebook Marketplace continua com Auto-Capture enquanto você navega, porque páginas em segundo plano podem depender da sessão/visibilidade.
- O Auto-Browse não tenta contornar login, CAPTCHA ou bloqueios do marketplace.

## Privacidade e limites

- Não solicita cookies, senhas ou armazenamento do marketplace.
- Não faz login em nome do usuário.
- Não tenta contornar CAPTCHA, 403, anti-bot ou páginas não carregadas.
- Usa `activeTab`, `scripting`, `storage`, `notifications` e `alarms`, além dos acessos de host às plataformas declarados no manifesto. O coletor automático pode ler cards em páginas visíveis mesmo sem um clique no popup.
- A comunicação com o Radar é restrita aos hosts locais `127.0.0.1:3130` e `localhost:3130`.
- A extração é heurística e pode precisar de ajustes se um marketplace alterar seu layout.

Na 0.3.12, título/foto alterados também geram nova captura, imagens lazy-loaded usam a foto disponível e falhas temporárias são tentadas novamente. Cancelar preserva a busca em andamento; desligar Auto-Browse limpa a fila. Consulte `docs/browser-extension.md` para os modos, intervalos e permissões completos.
