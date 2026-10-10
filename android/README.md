# Radar 2.0 Mobile - Android beta

Android WebView companion based on the existing hosted Radar Mobile.
It connects to https://radar-2-0-littleghoost.fly.dev/mobile/.
The search engine and listing database stay on the user's PC.

QR pairing opens the hosted pairing page. Tap 'Abrir no aplicativo Radar'
to transfer the one-time pairing token into the Android application.
Only the INTERNET permission is used. External listing links open in the browser.

Build with JDK17, Gradle 8.11.1, Android SDK35:
gradle assembleDebug

The GitHub workflow uploads app-debug.apk as radar-2-0-mobile-apk.
This is a DEBUG APK for testing only. Its signature may change on future CI
builds; a stable private signing key is needed for upgrades without reinstalling.
Do not commit private signing keys.

## Android beta 0.1.1 — abertura por QR

A página HTTPS de pareamento oferece abertura usando `intent://` do Chrome Android,
com o pacote explícito `com.littleghoost.radar2.mobile`. O APK recebe os campos
`pairing_id` e `pairing_secret` diretamente no Intent Android e abre a tela de
pareamento dentro do próprio WebView. Também aceita o link `radar2://pair#...`
para navegadores Android que oferecem suporte a esquemas personalizados.

Se o navegador bloquear o link, use **Copiar link para o aplicativo** na página
que a câmera abre. Depois, no APK, entre em **Conexão → Parear por link** e cole
o link temporário. O aplicativo só aceita URLs HTTPS do domínio oficial e valida
o identificador e o segredo de uso único; nenhum endereço arbitrário é carregado.

**Aviso sobre a beta de debug:** como os builds atuais são assinados com chaves
de debug efêmeras do CI, o Android pode recusar instalar este APK por cima da
beta antiga. Se isso acontecer, desinstale somente o **Radar 2.0 Mobile** beta
e instale o APK 0.1.1. Isso limpa somente os dados de pareamento do aplicativo
Android, não os radares/anúncios mantidos no Desktop. Gere um novo QR de uso
único; não use QR já conectado pelo navegador. A versão futura de produção
terá assinatura estável, para permitir atualizações normais.

## Beta 0.1.2: QR direto para o APK (Android App Links)

O QR contém um único link HTTPS oficial, sem página intermediária de opções.
O manifest Android registra HTTPS /mobile/pair.html com autoVerify=true;
a associação do domínio fica em /.well-known/assetlinks.json com o hash SHA-256
da assinatura do APK. Com a associação verificada pelo Android, escanear o QR
abre o aplicativo diretamente na tela Nome do aparelho / Conectar.

O Android pode abrir o navegador se a associação não estiver validada, se o
app não estiver instalado ou se o usuário tiver desativado a abertura
de links compatíveis (Informações do app > Abrir por padrão).

A beta de debug recebe um certificado temporário pelo CI. A associação
assetlinks.json precisa corresponder a cada APK. A solução duradoura
é configurar uma assinatura estável fora do repositório.
Nunca versionar chaves privadas de assinatura.

## Assinatura estável (para atualizar o APK sobre o anterior)

A assinatura da beta antiga de debug muda a cada build. Na transição para
uma assinatura permanente é necessária UMA ÚLTIMA desinstalação do APK antigo.
Após instalar a primeira versão assinada de forma permanente, novos APKs
podem instalar sobre ela sem perder os dados do Android.

A chave permanente foi criada no Windows e NÃO está versionada, em:
%APPDATA%\com.littleghoost.radar2\mobile-signing
Arquivos privados: radar-mobile-signing.p12, signing-password.txt,
signing-keystore-base64.txt, signing-sha256.txt.
A pasta é acessível apenas à conta Windows e SYSTEM. Mantenha backup privado.

Para ativar a assinatura no GitHub Actions, o proprietário do repositório deve
adicionar DOIS segredos em Settings > Secrets and variables > Actions:

RADAR_ANDROID_KEYSTORE_B64: conteúdo de signing-keystore-base64.txt
RADAR_ANDROID_STORE_PASSWORD: conteúdo de signing-password.txt

Use o PowerShell para copiar o valor sem exibir o segredo na tela:

Get-Content "$env:APPDATA\com.littleghoost.radar2\mobile-signing\signing-keystore-base64.txt" -Raw | Set-Clipboard

Get-Content "$env:APPDATA\com.littleghoost.radar2\mobile-signing\signing-password.txt" -Raw | Set-Clipboard

Após colar cada segredo no campo Value do GitHub, limpe o clipboard:
Set-Clipboard -Value ""

Após configurar AMBOS os secrets, executar o workflow Android. Ele produz
app-release.apk com a mesma identidade nas próximas versões.
Se eles não estiverem presentes, o build de debug ainda é efêmero e requer
desinstalação. Não distribuir esse build como se fosse atualização compatível.
O servidor oferece assetlinks.json com o certificado debug antigo e o estável
para não quebrar o QR durante a transição.
