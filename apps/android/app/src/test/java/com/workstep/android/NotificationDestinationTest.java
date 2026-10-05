package com.workstep.android;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class NotificationDestinationTest {
    @Test
    public void opensTheCompletedSessionEvenWhenWatchWasCreatedBeforeUrlUpdated() {
        assertEquals("/chat?project=Demo&session=new-session",
                NotificationDestination.path("/chat?project=Demo&session=old-session",
                        "new-session", ""));
    }

    @Test
    public void opensTheCompletedTaskFromAnotherCurrentPage() {
        assertEquals("/tasks?project=Demo&task=task-42",
                NotificationDestination.path("/chat?project=Demo&session=old", "", "task-42"));
        assertEquals("/tasks?project=Demo&workflow=flow-2&task=task-42",
                NotificationDestination.path("/tasks?project=Demo&workflow=flow-2&task=old",
                        "", "task-42"));
    }

    @Test
    public void keepsEncodedProjectAndEncodesIdentifiers() {
        assertEquals("/chat?project=My%20Project&session=session%2F1",
                NotificationDestination.path("/chat?project=My%20Project", "session/1", ""));
    }
}
