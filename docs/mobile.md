# Radar 2.0 Mobile v0.1

Primeiro companion mobile do Radar 2.0.

## Objetivo

Permitir que o celular funcione como painel de controle do Radar sem duplicar o motor de busca do Desktop.

Arquitetura inicial:

```
Celular (PWA) -> Radar Desktop/API -> SQLite local
```

A próxima fase troca a configuração manual do endereço por pareamento via QR Code e relay cloud:

```
Celular <-> Radar Cloud <-> Radar Desktop
```

## O que já existe na v0.1

- PWA instalável em Android/iOS compatível.
- Estado online/offline do Radar Desktop.
- Resumo de radares, anúncios, novos e interessantes.
- Lista dos radares configurados.
- Botão para executar um radar manualmente.
- Feed de anúncios com imagem, preço e score.
- Marcar anúncio como `interessante`.
- Descartar anúncio.
- Abrir o anúncio original.
- Filtro por status.
- Shell offline para a interface.
- Campo temporário para informar o endereço do Desktop.

## Como abrir

Com o backend Radar acessível pelo celular:

```
http://IP-DO-PC:3130/mobile/
```

Se a página for servida pelo próprio Radar, a PWA usa automaticamente a mesma origem da API.

O campo **Endereço do Radar** existe como fallback para desenvolvimento.

## Próxima fase: pareamento

1. Desktop gera um token de pareamento de uso único.
2. Desktop exibe QR Code contendo uma URL curta/token.
3. Celular escaneia o QR.
4. Cloud associa o dispositivo móvel à instalação Desktop.
5. Desktop mantém um canal autenticado com o relay.
6. Comandos mobile entram em uma fila:
   - rodar radar;
   - mudar status de anúncio;
   - importar link;
   - enviar imagem de referência.
7. Desktop consome comandos quando estiver online.
8. Cloud mantém apenas os dados necessários para sincronização, sem expor o SQLite local.

## Segurança planejada

- Token de pareamento de curta duração.
- Chaves distintas por dispositivo.
- Possibilidade de revogar um celular pelo Desktop.
- Nenhuma porta residencial precisa ficar exposta à internet.
- QR Code não contém credenciais permanentes.
- Ações sensíveis assinadas/autenticadas pelo relay.

## Fase seguinte

- QR Code de pareamento.
- Status Desktop online/offline em tempo real.
- Fila de comandos offline.
- Push notifications para grails e queda de preço.
- Importação de link pelo celular.
- Upload de imagem para Radar por imagem.
- Instalação Android como APK depois da validação da PWA.


## Fase 2 implementada na branch

A branch já contém o primeiro relay funcional para pareamento remoto:

- `server/mobileRelay.js`: registro do Desktop, pareamento temporário, dispositivos revogáveis, snapshot e fila de comandos.
- `server/services/mobileDesktopSync.js`: heartbeat do Desktop, snapshot periódico, polling de comandos e execução local.
- `/api/mobile/status`: estado da integração no Desktop.
- `/api/mobile/pairing`: gera link de pareamento de uso único.
- `/api/mobile/devices`: lista aparelhos pareados.
- `/api/mobile/devices/:id/revoke`: revoga um celular.
- `/api/mobile/sync-now`: força snapshot e consumo da fila.
- `/mobile-setup.html`: tela local para gerar link e gerenciar aparelhos.
- `/mobile/pair.html`: tela no celular que consome o pareamento e salva credenciais.
- PWA em modo Relay: usa snapshot cloud, mostra estado do Desktop e enfileira comandos.

### Segurança do MVP

As chaves de Desktop e celular são armazenadas no relay somente como SHA-256. O segredo de pareamento expira em 10 minutos, é de uso único e não vira credencial permanente. O celular pode ser revogado pelo Desktop e a revogação cancela comandos ainda pendentes.

### Comandos atualmente executáveis

- `run_radar`
- `update_listing_status`

O relay já aceita `import_url`, mas o executor do Desktop ainda responde como não implementado até o importador de URL ser integrado.

### Próxima revisão

1. Gerar QR Code localmente na página `mobile-setup.html`.
2. Adicionar atalho "Mobile" à interface principal do Desktop.
3. Testar ponta a ponta com o backend cloud publicado.
4. Adicionar importação de link no executor Desktop.
5. Push notifications para grails e quedas de preço.
