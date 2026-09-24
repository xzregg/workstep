package com.workstep.android;

import java.util.Locale;

/** Pure accept-type checks kept separate so chooser routing can be unit tested. */
public final class FileChooserMode {
    private FileChooserMode() {}

    public static boolean isImageOnly(String[] acceptTypes) {
        if (acceptTypes == null || acceptTypes.length == 0) return false;
        boolean found = false;
        for (String raw : acceptTypes) {
            if (raw == null || raw.trim().isEmpty()) continue;
            found = true;
            if (!raw.trim().toLowerCase(Locale.ROOT).startsWith("image/")) return false;
        }
        return found;
    }
}
