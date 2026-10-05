package com.workstep.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NotificationViewTest {
    private final ServerAddress server = ServerAddress.parse("https://workstep.example.com");

    @Test
    public void alertsForAnotherSessionWhileAppIsVisible() {
        String current = "https://workstep.example.com/chat?project=Demo&session=one";
        assertFalse(NotificationView.shouldNotify(current, "/chat?project=Demo&session=one", server));
        assertTrue(NotificationView.shouldNotify(current, "/chat?project=Demo&session=two", server));
        assertTrue(NotificationView.shouldNotify(current, "/chat?project=Other&session=one", server));
    }

    @Test
    public void alertsForAnotherTaskStepButNotTheOpenTask() {
        String current = "https://workstep.example.com/tasks?project=Demo&task=task-one";
        assertFalse(NotificationView.shouldNotify(current, "/tasks?project=Demo&task=task-one", server));
        assertTrue(NotificationView.shouldNotify(current, "/tasks?project=Demo&task=task-two", server));
        assertTrue(NotificationView.shouldNotify(current, "/chat?project=Demo&session=chat-one", server));
    }

    @Test
    public void alertsWhenNoMatchingDetailIsOpen() {
        assertTrue(NotificationView.shouldNotify("https://workstep.example.com/tasks?project=Demo",
                "/tasks?project=Demo&task=task-one", server));
        assertTrue(NotificationView.shouldNotify("https://workstep.example.com/settings",
                "/chat?project=Demo&session=chat-one", server));
    }
}
