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

## Android beta e QR aprimorado - 2026-10-10

O Android beta está na pasta android/, compilado com Gradle 8.11.1 no GitHub
Actions, usando a interface mobile hospedada pelo relay.

O fluxo QR é:
1. Desktop: clicar no atalho Conectar celular, gerar o QR de uso único.
2. Celular: escanear com a câmera, abrir a página HTTPS segura.
3. Clicar em Abrir no aplicativo Radar (esquema radar2://pair) para abrir o APK.
4. Confirmar o pareamento no APK, que guarda as credenciais na WebView privada.
5. Desktop detecta automaticamente que o token foi resgatado, limpa o QR e
   mostra confirmação. O pareamento expira após dez minutos.

A API do Desktop já lista aparelhos pareados e permite revogação. Os dados são
enviados apenas por HTTPS à nuvem, não há abertura de portas domésticas.
O APK debug não tem assinatura estável: usar como beta e não distribuir como
versão final. Próxima fase para produção: assinatura Android persistente,
notificações push nativas, tratamento offline e teste físico em celular.

## Catálogo completo no celular (Desktop 0.2.6)

O Desktop e o relay permitiam apenas 250 anúncios no snapshot. Os limites
foram ampliados para 1.000 anúncios por sincronização, suficientes para os
444 atuais. O tamanho máximo do snapshot é 1 MiB e o servidor aceita corpos
JSON de até 2 MiB. A lista Mobile exibe 60 cards por vez e traz um botão
"Mostrar mais anúncios" para acessar os demais sem travar o celular.
Testes cobrem 444 anúncios e o limite de 1.000.

Para catálogos que crescerem além de 1.000 anúncios, migrar o snapshot para
sincronização incremental/paginada com checkpoints; a solução atual não deve
ser interpretada como um espelho ilimitado da base local.
