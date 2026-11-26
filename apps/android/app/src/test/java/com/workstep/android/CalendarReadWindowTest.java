package com.workstep.android;

import static org.junit.Assert.*;
import org.junit.Test;

public class CalendarReadWindowTest {
    @Test public void readsOnlyABoundedVisibleMonth() {
        assertTrue(CalendarHost.validReadWindow(1, 1 + 42L * 86400000));
        assertFalse(CalendarHost.validReadWindow(1, 1));
        assertFalse(CalendarHost.validReadWindow(2, 1));
        assertFalse(CalendarHost.validReadWindow(0, 63L * 86400000));
        assertFalse(CalendarHost.validReadWindow(Long.MIN_VALUE, Long.MAX_VALUE));
    }
}
