package com.workstep.android;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLEncoder;

/** Builds a destination from the completed event, not a possibly stale page snapshot. */
final class NotificationDestination {
    static String path(String watchedPage, String sessionId, String taskId) {
        String project = "";
        String workflow = "";
        if (watchedPage != null && watchedPage.startsWith("/") && !watchedPage.startsWith("//")) {
            try {
                String query = new URI(watchedPage).getRawQuery();
                if (query != null) {
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
        boolean task = taskId != null && !taskId.isEmpty();
        String id = task ? taskId : sessionId;
        StringBuilder path = new StringBuilder(task ? "/tasks" : "/chat");
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
