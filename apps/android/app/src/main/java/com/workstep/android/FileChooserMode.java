package com.workstep.android;

import java.util.Locale;

/** Pure accept-type checks kept separate so chooser routing can be unit tested. */
public final class FileChooserMode {
    private FileChooserMode() {}

    public static boolean isImageOnly(String[] acceptTypes) {
        if (acceptTypes == null || acceptTypes.length == 0) return false;
        boolean found = false;
        for (String raw : acceptTypes) {
            if (raw == null) continue;
            for (String value : raw.split(",")) {
                String type = value.trim().toLowerCase(Locale.ROOT);
                if (type.isEmpty()) continue;
                found = true;
                if (!type.startsWith("image/")
                        && !type.matches("\\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|avif)")) return false;
            }
        }
        return found;
    }
}
