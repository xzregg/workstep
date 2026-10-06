package com.workstep.android;

/** A historical result must not complete a pending watch for a newer reply. */
final class CompletionWatchMatch {
    static boolean pending(boolean replay, double recordedAtSeconds, long startedAtMillis) {
        return !replay || startedAtMillis > 0 && recordedAtSeconds * 1000 >= startedAtMillis;
    }
}
