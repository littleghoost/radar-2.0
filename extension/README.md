# Radar 2.0 Bridge — extensão Chromium

Extensão Manifest V3 para Chrome/Chromium/Opera GX. Ela lê, somente quando o usuário clica em **Analisar página atual**, os cards já carregados na aba ativa e envia os anúncios escolhidos para o Radar Desktop local em `http://127.0.0.1:3130`.

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

### Auto-Browse (beta)

Desligado por padrão. Quando ativado, o Bridge consulta o Search Planner dos radares agendados e processa uma busca por vez em aba inativa. A aba é fechada logo após a captura.

- Câmeras: OLX, Enjoei e Mercado Livre.
- Roupas/geral: OLX, Enjoei, Mercado Livre e Depop.
- Facebook Marketplace continua com Auto-Capture enquanto você navega, porque páginas em segundo plano podem depender da sessão/visibilidade.
- O Auto-Browse não tenta contornar login, CAPTCHA ou bloqueios do marketplace.

## Privacidade e limites

- Não lê cookies, senhas, sessões ou armazenamento do marketplace.
- Não faz login em nome do usuário.
- Não tenta contornar CAPTCHA, 403, anti-bot ou páginas não carregadas.
- Usa `activeTab`, então só recebe acesso temporário à aba quando o usuário interage com a extensão.
- A comunicação com o Radar é restrita aos hosts locais `127.0.0.1:3130` e `localhost:3130`.
- A extração é heurística e pode precisar de ajustes se um marketplace alterar seu layout.
