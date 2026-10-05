package com.workstep.android;

/** JSONObject.optString can turn JSON null into the literal string "null". */
final class NotificationIds {
    static String value(String value) {
        return value == null || "null".equals(value) ? "" : value;
    }

    private NotificationIds() { }
}
