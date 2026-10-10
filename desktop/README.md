# Radar 2.0 Desktop

Aplicativo desktop do Radar usando Tauri 2.

## Estado atual

O app agora empacota o backend Node.js como um **sidecar nativo**. A instalação final não precisa de WSL nem de Node.js para iniciar o Radar. O sidecar sobe o mesmo backend Express na porta local `3130`, e a janela Tauri abre a interface web existente.

O SQLite do desktop fica no diretório de dados do aplicativo. No Windows:

`%APPDATA%\com.littleghoost.radar2\radar-desktop.db`

O processo auxiliar é encerrado junto com a janela do Radar.

## Build Windows

Pré-requisitos de desenvolvimento: Rust/MSVC, WebView2 e Node.js. Na raiz do projeto, instale as dependências do backend; depois, em `desktop/`:

```bash
npm install
npm run build:sidecar
npm run tauri build
```

Ou use:

```bash
npm run build:desktop
```

`build:sidecar` usa `@yao-pkg/pkg` para gerar `src-tauri/binaries/radar-backend-<target>.exe`. O Tauri inclui esse executável automaticamente no instalador por `bundle.externalBin`.

## Próximas fases

- ícone próprio e identidade visual do Radar;
- tray e execução em segundo plano;
- notificações nativas para novos achados/queda de preço;
- iniciar com o Windows;
- scheduler local chamando `runDueRadars`;
- sincronização opcional com o servidor.

## Modo em segundo plano

O Desktop mantém o Radar ativo ao fechar a janela: o clique no X oculta a interface e deixa o processo no system tray. O menu do tray permite abrir o Radar, rodar os radares imediatamente ou sair de verdade.

O scheduler local consulta os radares preparados a cada 5 minutos e chama `POST /api/scheduler/run-due`. Quando uma execução cria novos anúncios, quedas de preço ou alertas importantes, o app dispara uma notificação nativa do Windows.

## Configurações do modo background

A página **Perfil** agora inclui um painel do Radar Desktop com:

- iniciar com o Windows;
- ativar/desativar o monitoramento em segundo plano;
- intervalo de verificação dos agendamentos (5, 15, 30 ou 60 minutos);
- filtros para notificações de novos anúncios, quedas de preço e falhas;
- opção de iniciar minimizado no tray quando o Windows abrir o app.

As preferências ficam salvas no SQLite local do desktop. O autostart usa o plugin oficial `tauri-plugin-autostart` e é sincronizado pelo processo desktop; o app só registra a inicialização automática quando a opção estiver ligada.

## Atualizações do Radar Desktop

A partir da versão **0.2.0**, o Desktop mostra um painel **Perfil → Atualizações**:
- identifica a versão instalada diretamente do executável Tauri;
- consulta a última versão estável em `github.com/littleghoost/radar-2.0/releases`;
- mostra um aviso quando existir uma versão mais recente e apresenta notas da versão;
- abre o download do instalador Windows publicado no repositório oficial.

A verificação automática usa a API pública do GitHub e não envia anúncios, credenciais ou informações pessoais. Há cache de quinze minutos e um botão para verificar novamente.

**Instalação ainda é confirmada pelo usuário.** O botão baixa o instalador oficial no navegador, mas não o executa silenciosamente. Para substituir uma versão anterior, feche o Radar pelo menu da bandeja (Sair do Radar), rode o instalador novo e abra o Radar. A pasta de dados do usuário não é modificada pela atualização.

### Como publicar uma versão

1. Atualize a mesma versão semântica em `desktop/package.json`, `desktop/src-tauri/tauri.conf.json` e `desktop/src-tauri/Cargo.toml`; atualize `desktop/package-lock.json` executando `npm install --package-lock-only`.
2. Teste e envie as alterações à branch `main`.
3. Crie e envie uma tag **de versão estável** correspondente, por exemplo `v0.2.0`.
4. O workflow de Windows compila o NSIS e publica automaticamente o instalador na página **GitHub Releases**. O painel do Desktop passa a encontrá-lo.

**Segurança:** o checker só apresenta releases estáveis com instalador Windows e links do repositório oficial. Atualização de um clique (baixar, validar assinatura, instalar e reiniciar sem sair do app) dependerá de configurar chaves de assinatura Tauri, GitHub Actions Secrets e o plugin oficial de updater. Não instale binários silenciosamente sem essa verificação criptográfica.


## Proteção das APIs oficiais — 0.2.1

As chamadas das APIs oficiais do eBay e Mercado Livre compartilham um limitador local por host:
- no máximo duas conexões simultâneas por API;
- intervalo mínimo de 500 ms entre inícios das requisições;
- limite de tempo de 15 segundos por requisição e uma nova tentativa apenas para falha de rede;
- pausa automática após HTTP 429 (mínimo 60 segundos), HTTP 403 (5 minutos) e HTTP 503 (mínimo 20 segundos);
- cabeçalho `Retry-After` respeitado quando pedir uma pausa maior (até 30 minutos);
- requisições na fila são canceladas durante a pausa, sem tentativa imediata de contornar restrições.

Em **Conexões → Proteção das APIs**, veja se cada fonte está liberada ou em pausa.
A proteção opera enquanto o backend local estiver aberto. Reiniciar o processo zera a pausa
em memória; isto não deve ser usado para contornar limites dos provedores.

Esta proteção **não inclui** a coleta feita pela extensão Bridge no navegador nem garante que
as plataformas nunca bloqueiem requisições. Para fontes não homologadas, mantenha a integração
automática desativada até conseguir acesso autorizado.

## Atualizar pelo PowerShell (sem clonar o repositório)

O atualizador fica em `scripts/update-radar.ps1` e funciona no **Windows PowerShell 5.1** ou no PowerShell 7. Para atualizar o aplicativo instalado, abra o **PowerShell normal** (não exige administrador só para baixar) e execute:

```powershell
Invoke-WebRequest "https://raw.githubusercontent.com/littleghoost/radar-2.0/main/scripts/update-radar.ps1" -OutFile "$env:TEMP\update-radar.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\update-radar.ps1"
```

O `-ExecutionPolicy Bypass` vale apenas para esse processo e permite executar o arquivo obtido do repositório oficial; revise o script e o endereço antes de executá-lo. O comando nunca executa diretamente conteúdo remoto sem salvar o arquivo para inspeção.

Funcionalidades:
- Usa a API oficial de Releases do GitHub e aceita apenas versões estáveis;
- verifica a versão instalada no registro do Windows;
- baixa ou reutiliza o instalador NSIS oficial do Radar;
- **verifica o hash SHA-256 contra o digest publicado pelo GitHub**, recusando instalar em caso de divergência;
- com `-CheckOnly`, consulta a última versão sem baixar;
- com `-DownloadOnly`, baixa e verifica sem abrir o instalador;
- antes de instalar, pede para sair do Radar pela bandeja do Windows, sem encerrar processos à força.

Para conferir sem instalar:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\update-radar.ps1" -CheckOnly
```

A atualização não apaga o banco local. Esse método é **assistido** (não silencioso): o Windows abrirá o instalador e o usuário confirmará a instalação. Para atualizações inteiramente automáticas, ainda será preciso implementar o updater Tauri com assinatura criptográfica.

## Atualizar direto pelo PowerShell — v0.2.2

Em **Perfil → Atualizações**, clique **Verificar atualizações**. Havendo uma versão oficial mais nova,
o Radar exibe o comando do PowerShell e oferece **Copiar comando de instalação**.

Cole o comando em uma janela de PowerShell (ele baixa o script oficial para um arquivo local
e executa com `-AutoInstall`). Esse modo:

1. Detecta a versão instalada e a mais recente do GitHub Releases.
2. Baixa ou reutiliza o instalador e confere seu SHA-256.
3. Se o Radar estiver aberto, espera por até dois minutos que o usuário encerre o app
   pelo menu do tray (aguarde buscas em andamento, escolha **Sair do Radar**).
4. Executa o instalador NSIS com `/S`, aguarda a conclusão e confirma a versão instalada no registro.
5. Não força o encerramento do app nem altera o banco local.

O usuário sempre inicia a atualização executando o comando. A instalação ocorre
sem a interface tradicional do instalador; eventuais avisos do Windows/UAC ainda podem aparecer.
Se não quiser instalar de imediato, use `-CheckOnly` ou `-DownloadOnly`.
O comando deve ser obtido do repositório oficial; revise scripts externos antes de executá-los.

### Downloads mais rápidos pelo PowerShell

O script de atualização usa `curl.exe` no Windows quando disponível, com barra de progresso simples,
repetições limitadas para falhas de rede e tentativa de continuar downloads parciais. Se não houver
`curl.exe`, usa o PowerShell com indicador de progresso desativado para evitar lentidão no console.
O SHA-256 do GitHub continua sendo verificado antes de executar qualquer instalador. A velocidade
real depende da conexão e do GitHub; o script não promete aumento garantido.

O script fica no GitHub `main`, então melhorias nele passam a valer na **próxima vez** que o
usuário copiar e executar o comando. Um download já iniciado mantém o comportamento anterior.

## Encerramento automático durante atualização — 0.2.3

A partir da versão 0.2.3, o script `scripts/update-radar.ps1 -AutoInstall` pode
**fechar o aplicativo sozinho** antes de instalar, inclusive se ele estiver oculto
na bandeja. O procedimento protegido usa:

1. Um token aleatório gerado a cada execução pelo backend Desktop, salvo em
   `%APPDATA%\com.littleghoost.radar2\update-control.json` na conta local.
2. Solicitação autenticada por loopback para entrar em modo de atualização.
3. O backend **recusa novas buscas** e espera todas as buscas já iniciadas terminarem.
4. O Tauri acompanha a confirmação de que não há mais buscas ativas, chama seu
   procedimento normal de saída e libera o banco SQLite.
5. O PowerShell espera o encerramento real e executa o NSIS `/S` somente
   após o programa fechar.

**Compatibilidade:** versões anteriores à 0.2.3 não implementam essa saída
protegida. Nelas, o script só usa `taskkill /T /F` se a API local responder e
se **duas verificações consecutivas** confirmarem que nenhuma busca aparece
como `running`. Caso contrário, o instalador não é executado. Não há garantia
absoluta de eliminação de condições de corrida no modo legado; a partir da
0.2.3, o protocolo protegido evita iniciar novas buscas durante o encerramento.

O novo protocolo só está habilitado no backend local; o servidor Fly.io não
aceita comandos de encerramento. A API Desktop escuta apenas no endereço
`127.0.0.1` e a solicitação é autenticada por token por processo.
