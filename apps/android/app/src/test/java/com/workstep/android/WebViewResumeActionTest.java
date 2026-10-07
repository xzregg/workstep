package com.workstep.android;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class WebViewResumeActionTest {
    @Test
    public void notificationOverridesOldPageRefresh() {
        assertEquals(WebViewResumeAction.NOTIFICATION, WebViewResumeAction.choose(true, false, true));
        assertEquals(WebViewResumeAction.NOTIFICATION, WebViewResumeAction.choose(true, true, true));
    }

    @Test
    public void resumedActivityDoesNotInterruptANotificationAlreadyLoading() {
        assertEquals(WebViewResumeAction.WAIT, WebViewResumeAction.choose(false, true, true));
        assertEquals(WebViewResumeAction.RELOAD, WebViewResumeAction.choose(false, false, true));
        assertEquals(WebViewResumeAction.RESUME, WebViewResumeAction.choose(false, false, false));
    }
}
