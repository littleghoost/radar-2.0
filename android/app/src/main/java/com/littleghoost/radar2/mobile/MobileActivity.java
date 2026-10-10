package com.littleghoost.radar2.mobile;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.graphics.Color;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;
import android.webkit.ValueCallback;
import android.widget.Toast;

public final class MobileActivity extends Activity {
    private static final String HOST = "radar-2-0-littleghoost.fly.dev";
    private static final String HOME = "https://" + HOST + "/mobile/";
    private static final int FILE_REQUEST = 501;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(11,13,16));
        getWindow().setNavigationBarColor(Color.rgb(11,13,16));

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(11,13,16));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view,
                    ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                    return true;
                } catch (Exception ex) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    Toast.makeText(MobileActivity.this, "Galeria indisponível", Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return handleNavigation(req.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url));
            }
        });
        setContentView(web);
        handleIntent(getIntent());
    }

    private boolean handleNavigation(Uri uri) {
        String scheme = uri.getScheme();
        if ("radar2".equalsIgnoreCase(scheme) && "pair".equalsIgnoreCase(uri.getHost())) {
            openPair(uri);
            return true;
        }
        if ("https".equalsIgnoreCase(scheme) && HOST.equalsIgnoreCase(uri.getHost())
                && uri.getPath() != null
                && (uri.getPath().equals("/mobile") || uri.getPath().startsWith("/mobile/"))) {
            return false;
        }
        if (scheme == null || (!scheme.equalsIgnoreCase("https") && !scheme.equalsIgnoreCase("mailto")))
            return true;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            Toast.makeText(this, "Não foi possível abrir o link", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void openPair(Uri uri) {
        String hash = uri.getEncodedFragment();
        if (hash == null || hash.isEmpty() || hash.length() > 700) {
            Toast.makeText(this, "QR inválido", Toast.LENGTH_LONG).show();
            web.loadUrl(HOME);
            return;
        }
        web.loadUrl(HOME + "pair.html#" + hash);
    }

    private void handleIntent(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data != null && "radar2".equalsIgnoreCase(data.getScheme())
                && "pair".equalsIgnoreCase(data.getHost())) openPair(data);
        else web.loadUrl(HOME);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
