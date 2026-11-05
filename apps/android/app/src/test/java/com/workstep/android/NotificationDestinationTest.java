package com.workstep.android;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class NotificationDestinationTest {
    @Test
    public void backgroundCompletionKeepsTheDirectWorkspaceDestination() {
        assertEquals("/workspace/device/chat?project=My%20Project&session=new",
                NotificationDestination.path("/workspace/device/chat?project=My%20Project&session=old", "new", ""));
        assertEquals("/workspace/device/tasks?project=Demo&workflow=f&task=t",
                NotificationDestination.path("/workspace/device/tasks?project=Demo&workflow=f&task=old", "", "t"));
        assertEquals("/chat?project=gateway%2Fdevice%2Fp&session=new",
                NotificationDestination.path("/workspace/device/chat?project=gateway%2Fdevice%2Fp&session=old", "new", ""));
    }
    @Test
    public void replayedSessionWithJsonNullTaskOpensTheSession() {
        assertEquals("/chat?project=Demo&session=session-1",
                NotificationDestination.path("/chat?project=Demo", "session-1", "null"));
    }

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

    @Test
    public void sessionChatEventOpensSessionEvenIfItAlsoCarriesTaskId() {
        assertEquals("/chat?project=Demo&session=session-1",
                NotificationDestination.path("/chat?project=Demo&session=old",
                        "session-1", "unrelated-task", "session_chat"));
    }
}
