package com.workstep.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class ConnectionRecoveryTest {
    @Test
    public void reportsOnlyAfterTheReconnectAlsoFailsAndOncePerOutage() {
        ConnectionRecovery recovery = new ConnectionRecovery();
        assertFalse(recovery.failed());
        assertTrue(recovery.failed());
        assertFalse(recovery.failed());
        assertFalse(recovery.failed());
    }

    @Test
    public void aSuccessfulReconnectResetsTheErrorWindow() {
        ConnectionRecovery recovery = new ConnectionRecovery();
        assertFalse(recovery.connected());
        assertFalse(recovery.failed());
        assertTrue(recovery.connected());
        assertFalse(recovery.failed());
        assertTrue(recovery.failed());
        assertTrue(recovery.connected());
        assertFalse(recovery.failed());
    }
}
