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
