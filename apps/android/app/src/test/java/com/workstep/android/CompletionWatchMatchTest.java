package com.workstep.android;

import static org.junit.Assert.*;
import org.junit.Test;

public class CompletionWatchMatchTest {
    @Test
    public void previousReplyCannotConsumeANewPendingWatchDuringReplay() {
        assertFalse(CompletionWatchMatch.pending(true, 100, 101000));
        assertFalse(CompletionWatchMatch.pending(true, 0, 101000));
        assertTrue(CompletionWatchMatch.pending(true, 102, 101000));
        assertTrue(CompletionWatchMatch.pending(false, 0, 101000));
    }
}
