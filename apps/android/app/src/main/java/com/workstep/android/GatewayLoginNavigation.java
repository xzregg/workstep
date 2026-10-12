package com.workstep.android;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Keeps one Gateway login and its HTTPS identity redirects in the current WebView. */
final class GatewayLoginNavigation {
    private ServerAddress gateway;

    boolean staysInWebView(ServerAddress server, String url) {
        if (server == null || url == null) return false;
        try {
            URI target = new URI(url);
            if (beginsExternalIdentity(server, target)) {
                gateway = server;
                return true;
            }
            if (WebNavigation.staysInWebView(server, url)) return true;
            if (target.getHost() == null || target.getRawUserInfo() != null
                    || !("https".equalsIgnoreCase(target.getScheme())
                    || "http".equalsIgnoreCase(target.getScheme()))) return false;
            if (gateway != null) {
                return gateway.contains(url) || "https".equalsIgnoreCase(target.getScheme());
            }
            if (!"/desktop/login".equals(target.getPath()) || target.getRawFragment() != null) return false;
            String callback = callbackParameter(target.getRawQuery());
            if (callback == null || !(server.contains(callback) || isTlsProxyCallback(server, callback))) return false;
            URI redirect = new URI(callback);
            if (!"/api/gateway-platform/callback".equals(redirect.getPath())
                    || redirect.getRawQuery() != null || redirect.getRawFragment() != null) return false;
            gateway = ServerAddress.parse(target.getScheme() + "://" + target.getRawAuthority());
            return true;
        } catch (IllegalArgumentException | URISyntaxException | UnsupportedEncodingException error) {
            return false;
        }
    }

    void pageStarted(ServerAddress server, String url) {
        if (server != null && server.contains(url)) reset();
    }

    void reset() {
        gateway = null;
    }

    private static boolean isTlsProxyCallback(ServerAddress server, String callback) throws URISyntaxException {
        URI publicOrigin = new URI(server.origin());
        URI candidate = new URI(callback);
        return "https".equals(publicOrigin.getScheme()) && publicOrigin.getPort() == -1
                && "http".equalsIgnoreCase(candidate.getScheme())
                && (candidate.getPort() == -1 || candidate.getPort() == 80)
                && candidate.getHost() != null
                && candidate.getRawUserInfo() == null
                && publicOrigin.getHost().equalsIgnoreCase(candidate.getHost());
    }

    private static boolean beginsExternalIdentity(ServerAddress server, URI target)
            throws URISyntaxException, UnsupportedEncodingException {
        if (!"https".equalsIgnoreCase(target.getScheme()) || target.getHost() == null
                || target.getRawUserInfo() != null || (target.getPort() != -1 && target.getPort() != 443)) return false;
        String host = target.getHost().toLowerCase(Locale.ROOT);
        String path = target.getPath();
        if (!("login.dingtalk.com".equals(host) && "/oauth2/auth".equals(path))
                && !("open.work.weixin.qq.com".equals(host) && "/wwopen/sso/qrConnect".equals(path))) return false;
        String callback = callbackParameter(target.getRawQuery());
        if (callback == null || !server.contains(callback)) return false;
        URI redirect = new URI(callback);
        return redirect.getPath().matches("/api/auth/external/[^/]+/callback")
                && redirect.getRawQuery() == null && redirect.getRawFragment() == null;
    }

    private static String callbackParameter(String query) throws UnsupportedEncodingException {
        if (query == null) return null;
        String callback = null;
        for (String pair : query.split("&")) {
            String[] parts = pair.split("=", 2);
            if (!"redirect_uri".equals(parts[0])) continue;
            if (callback != null || parts.length != 2) return null;
            callback = URLDecoder.decode(parts[1], StandardCharsets.UTF_8.name());
        }
        return callback;
    }
}
