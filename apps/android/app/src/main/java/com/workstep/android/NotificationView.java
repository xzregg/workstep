package com.workstep.android;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;

/** Suppresses a notice only when the exact conversation or task is open. */
final class NotificationView {
    static boolean shouldNotify(String currentUrl, String targetPath, ServerAddress server) {
        if (server == null || currentUrl == null || targetPath == null
                || !targetPath.startsWith("/") || targetPath.startsWith("//")
                || !server.contains(currentUrl)) return true;
        String targetUrl = server.origin() + targetPath;
        if (!server.contains(targetUrl)) return true;
        try {
            URI current = new URI(currentUrl);
            URI target = new URI(targetUrl);
            String route = target.getPath();
            if (!route.equals(current.getPath())) return true;
            String key = "/chat".equals(route) ? "session" : "/tasks".equals(route) ? "task" : null;
            if (key == null) return true;
            String project = parameter(target.getRawQuery(), "project");
            String id = parameter(target.getRawQuery(), key);
            return project.isEmpty() || id.isEmpty()
                    || !project.equals(parameter(current.getRawQuery(), "project"))
                    || !id.equals(parameter(current.getRawQuery(), key));
        } catch (URISyntaxException | IllegalArgumentException error) {
            return true;
        }
    }

    private static String parameter(String query, String key) {
        if (query == null) return "";
        for (String pair : query.split("&")) {
            int separator = pair.indexOf('=');
            if (separator < 0 || !key.equals(pair.substring(0, separator))) continue;
            try {
                return URLDecoder.decode(pair.substring(separator + 1), "UTF-8");
            } catch (UnsupportedEncodingException error) {
                throw new AssertionError(error);
            }
        }
        return "";
    }

    private NotificationView() { }
}
