package com.workstep.android;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLEncoder;

/** Builds a destination from the completed event, not a possibly stale page snapshot. */
final class NotificationDestination {
    static String path(String watchedPage, String sessionId, String taskId) {
        return path(watchedPage, sessionId, taskId, null);
    }

    static String path(String watchedPage, String sessionId, String taskId, String channel) {
        sessionId = NotificationIds.value(sessionId);
        taskId = NotificationIds.value(taskId);
        String project = "";
        String workflow = "";
        String workspace = "";
        if (watchedPage != null && watchedPage.startsWith("/") && !watchedPage.startsWith("//")) {
            try {
                URI watched = new URI(watchedPage);
                String watchedPath = watched.getRawPath();
                if (watchedPath.matches("/workspace/[^/]+/(?:chat|tasks)"))
                    workspace = watchedPath.substring(0, watchedPath.lastIndexOf('/'));
                String query = watched.getRawQuery();
                if (query != null) {
                    // Older web builds put a scoped ID into workspace URLs. Such
                    // IDs still need the Gateway resolver, not the device page.
                    for (String parameter : watched.getQuery().split("&"))
                        if (parameter.startsWith("project=gateway/")) workspace = "";
                    for (String parameter : query.split("&")) {
                        if (parameter.startsWith("project=")) {
                            project = parameter;
                        } else if (parameter.startsWith("workflow=")) {
                            workflow = parameter;
                        }
                    }
                }
            } catch (URISyntaxException ignored) { }
        }
        boolean task = taskId != null && !taskId.isEmpty()
                && !("session_chat".equals(channel) && sessionId != null && !sessionId.isEmpty());
        String id = task ? taskId : sessionId;
        StringBuilder path = new StringBuilder(workspace).append(task ? "/tasks" : "/chat");
        if (!project.isEmpty()) path.append('?').append(project);
        if (task && !workflow.isEmpty()) path.append(project.isEmpty() ? '?' : '&').append(workflow);
        if (id != null && !id.isEmpty()) {
            path.append(project.isEmpty() && (workflow.isEmpty() || !task) ? '?' : '&')
                    .append(task ? "task=" : "session=").append(encode(id));
        }
        return path.toString();
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (UnsupportedEncodingException error) {
            throw new AssertionError(error);
        }
    }

    private NotificationDestination() { }
}
