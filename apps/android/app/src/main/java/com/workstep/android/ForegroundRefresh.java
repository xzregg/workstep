package com.workstep.android;

/** Tracks whether a return to the app should refresh its WebView. */
final class ForegroundRefresh {
    private static final long REFRESH_AFTER_MS = 5 * 60_000L;
    private boolean stopped;
    private long stoppedAt;
    private boolean externalPicker;

    void onStop(long elapsedRealtime) {
        stopped = true;
        stoppedAt = elapsedRealtime;
    }

    void externalPickerStarted() {
        externalPicker = true;
    }

    boolean onResume(long elapsedRealtime) {
        boolean refresh = stopped && !externalPicker
                && elapsedRealtime - stoppedAt >= REFRESH_AFTER_MS;
        stopped = false;
        externalPicker = false;
        return refresh;
    }
}
