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
