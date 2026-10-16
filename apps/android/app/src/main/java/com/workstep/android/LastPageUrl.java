package com.workstep.android;

import java.net.URI;
import java.net.URISyntaxException;

/** Keep a useful detail when Gateway briefly redirects through its portal. */
final class LastPageUrl {
    static boolean shouldRemember(ServerAddress server, String url) {
        if (server == null || url == null || !server.contains(url)) return false;
        try {
            URI page = new URI(url);
            String path = page.getPath();
            String query = page.getRawQuery();
            if (path == null || query == null || !hasValue(query, "project")) return false;
            if (path.matches("(?:/workspace/[^/]+)?/chat")) return hasValue(query, "session");
            if (path.matches("(?:/workspace/[^/]+)?/tasks")) return hasValue(query, "task");
            return false;
        } catch (URISyntaxException error) {
            return false;
        }
    }

    private static boolean hasValue(String query, String key) {
        for (String field : query.split("&"))
            if (field.startsWith(key + "=") && field.length() > key.length() + 1) return true;
        return false;
    }

    private LastPageUrl() { }
}
