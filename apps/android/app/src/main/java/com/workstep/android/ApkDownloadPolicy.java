package com.workstep.android;

import java.util.Locale;

final class ApkDownloadPolicy {
    static boolean isApk(String filename, String mime) {
        String name = filename == null ? "" : filename.toLowerCase(Locale.ROOT);
        String type = mime == null ? "" : mime.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return name.endsWith(".apk") || "application/vnd.android.package-archive".equals(type);
    }

    private ApkDownloadPolicy() { }
}
