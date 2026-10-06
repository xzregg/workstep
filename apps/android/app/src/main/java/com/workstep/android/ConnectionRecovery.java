package com.workstep.android;

/** Reports one error per outage, only after a reconnect has also failed. */
final class ConnectionRecovery {
    private boolean interrupted;
    private boolean reported;

    boolean failed() {
        if (!interrupted) {
            interrupted = true;
            return false;
        }
        if (reported) return false;
        reported = true;
        return true;
    }

    boolean connected() {
        boolean recovered = interrupted;
        interrupted = false;
        reported = false;
        return recovered;
    }
}
