package com.workstep.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ForegroundRefreshTest {
    @Test
    public void refreshesOnlyAfterFiveMinutesInBackground() {
        ForegroundRefresh refresh = new ForegroundRefresh();
        assertFalse(refresh.onResume(0));
        refresh.onStop(1_000);
        assertFalse(refresh.onResume(300_999));
        refresh.onStop(400_000);
        assertTrue(refresh.onResume(700_000));
        assertFalse(refresh.onResume(700_001));
    }

    @Test
    public void returningFromFilePickerDoesNotReloadTheUpload() {
        ForegroundRefresh refresh = new ForegroundRefresh();
        refresh.externalPickerStarted();
        refresh.onStop(1_000);
        assertFalse(refresh.onResume(301_000));
        refresh.onStop(400_000);
        assertTrue(refresh.onResume(700_000));
    }
}
