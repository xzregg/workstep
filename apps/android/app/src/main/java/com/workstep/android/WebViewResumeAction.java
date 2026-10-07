package com.workstep.android;

/** A notification navigation and foreground refresh must not start two loads. */
enum WebViewResumeAction {
    NOTIFICATION, WAIT, RELOAD, RESUME;

    static WebViewResumeAction choose(boolean notification, boolean loading, boolean reload) {
        if (notification) return NOTIFICATION;
        if (loading) return WAIT;
        return reload ? RELOAD : RESUME;
    }
}
