package com.workstep.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** An HTTP or HTTPS origin serving the WorkStep web UI, API, and WebSocket endpoint. */
public final class ServerAddress {
    private final String origin;

    private ServerAddress(String origin) {
        this.origin = origin;
    }

    public static ServerAddress parse(String input) {
        try {
            URI uri = new URI(input.trim());
            String path = uri.getRawPath();
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!("https".equals(scheme) || "http".equals(scheme)) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                    || uri.getRawFragment() != null || !(path.isEmpty() || "/".equals(path))
                    || uri.getPort() == 0 || uri.getPort() > 65535) {
                throw new IllegalArgumentException("请输入 HTTP 或 HTTPS 服务根地址");
            }
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (host.contains(":")) host = "[" + host + "]";
            int port = uri.getPort();
            int defaultPort = "https".equals(scheme) ? 443 : 80;
            return new ServerAddress(scheme + "://" + host + (port < 0 || port == defaultPort ? "" : ":" + port));
        } catch (NullPointerException | URISyntaxException error) {
            throw new IllegalArgumentException("请输入有效的 HTTP 或 HTTPS 服务根地址", error);
        }
    }

    public String origin() {
        return origin;
    }

    public String pageOrRoot(String page) {
        return page != null && contains(page) ? page : origin + "/";
    }

    public boolean contains(String value) {
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!("https".equals(scheme) || "http".equals(scheme)) || uri.getHost() == null
                    || uri.getRawUserInfo() != null) return false;
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (host.contains(":")) host = "[" + host + "]";
            int port = uri.getPort();
            int defaultPort = "https".equals(scheme) ? 443 : 80;
            String candidate = scheme + "://" + host + (port < 0 || port == defaultPort ? "" : ":" + port);
            return origin.equals(candidate);
        } catch (URISyntaxException error) {
            return false;
        }
    }

    public String resolveSameOrigin(String current, String location) {
        try {
            if (!contains(current)) throw new IllegalArgumentException("下载地址不属于当前服务");
            URI resolved = new URI(current).resolve(new URI(location));
            String destination = resolved.toString();
            if (!contains(destination)) throw new IllegalArgumentException("下载重定向离开当前服务");
            return destination;
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("无效的下载重定向地址", error);
        }
    }
}
