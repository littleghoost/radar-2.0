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
