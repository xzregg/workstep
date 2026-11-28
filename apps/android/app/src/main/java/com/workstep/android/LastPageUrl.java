package com.workstep.android;

import java.net.URI;
import java.net.URISyntaxException;

/** Restore a useful detail across Gateway and P2P connections. */
final class LastPageUrl {
    static boolean shouldRemember(ServerAddress server, String url) {
        if (server == null || url == null || !server.contains(url)) return false;
        try {
            URI page = new URI(url);
            String path = page.getPath();
            String query = page.getRawQuery();
            if (path == null) return false;
            return isDetail(path.replaceFirst("^/workspace/[^/]+(?=/)", ""), query);
        } catch (URISyntaxException error) {
            return false;
        }
    }

    static String p2pDetail(P2pConnection connection, String url) {
        if (url == null || !connection.server().contains(url)) return null;
        URI page = URI.create(url);
        String prefix = URI.create(connection.entryUrl()).getRawPath();
        String path = page.getRawPath();
        if (path == null || !path.startsWith(prefix)) return null;
        String route = path.substring(prefix.length() - 1);
        String query = page.getRawQuery();
        return isDetail(route, query) ? connection.entryUrl() + route.substring(1) + "?" + query : null;
    }

    static String p2pLaunchUrl(P2pConnection connection, String savedPage) {
        String detail = p2pDetail(connection, savedPage);
        return detail == null ? connection.pairingUrl() : detail + "#pair_key=" + connection.key();
    }

    private static boolean isDetail(String route, String query) {
        if (query == null || !hasValue(query, "project")) return false;
        if ("/chat".equals(route)) return hasValue(query, "session");
        return "/tasks".equals(route) && hasValue(query, "task");
    }

    private static boolean hasValue(String query, String key) {
        for (String field : query.split("&"))
            if (field.startsWith(key + "=") && field.length() > key.length() + 1) return true;
        return false;
    }

    private LastPageUrl() { }
}
