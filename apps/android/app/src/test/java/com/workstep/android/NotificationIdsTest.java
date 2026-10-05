package com.workstep.android;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class NotificationIdsTest {
    @Test
    public void absentJsonIdsAreEmptyAndRealIdsArePreserved() {
        assertEquals("", NotificationIds.value(null));
        assertEquals("", NotificationIds.value("null"));
        assertEquals("", NotificationIds.value(""));
        assertEquals("session-1", NotificationIds.value("session-1"));
    }
}
