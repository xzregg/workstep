package com.workstep.android;

/** Notification wording shared by every background result path. */
final class NotificationContent {
    static String name(String storedName, String sessionId, String taskId) {
        String name = NotificationIds.value(storedName).trim();
        if (!name.isEmpty()) return shortName(name);
        return shortName(!taskId.isEmpty() ? "任务 " + taskId : "会话 " + sessionId);
    }

    static String bridgeName(String provided, String watched, String sessionId, String taskId) {
        return name(NotificationIds.value(provided).trim().isEmpty() ? watched : provided, sessionId, taskId);
    }

    static String title(String name, boolean step, boolean success) {
        return shortName(name) + " · " + (step ? "步骤" : "回复") + (success ? "完成" : "失败");
    }

    static String body(String name, boolean task, String stepKey, boolean success) {
        name = shortName(name);
        if (!stepKey.isEmpty()) return "任务「" + name + "」：步骤 " + stepKey + (success ? " 已通过" : " 执行失败");
        return (task ? "任务" : "会话") + "「" + name + "」的回复" + (success ? "已完成" : "失败");
    }
    private static String shortName(String value) {
        String name = value.replaceAll("\\s+", " ").trim();
        return name.codePointCount(0, name.length()) > 20
                ? name.substring(0, name.offsetByCodePoints(0, 19)) + "…" : name;
    }
}

