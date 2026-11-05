package com.workstep.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NotificationViewTest {
    private final ServerAddress server = ServerAddress.parse("https://workstep.example.com");

    @Test
    public void notificationClickReusesTheOpenGatewayConversation() {
        String current = server.origin() + "/workspace/one/chat?session=s&project=Demo";
        String target = server.origin() + "/chat?project=gateway%2Fone%2Fp&session=s";
        assertTrue(NotificationView.isCurrentDestination(current, target, server, "gateway/one/p", "Demo"));
        assertFalse(NotificationView.isCurrentDestination(current, target.replace("session=s", "session=other"),
                server, "gateway/one/p", "Demo"));
        assertFalse(NotificationView.isCurrentDestination(current.replace("/one/", "/two/"), target,
                server, "gateway/one/p", "Demo"));
        assertFalse(NotificationView.isCurrentDestination(current.replace("Demo", "Other"), target,
                server, "gateway/one/p", "Demo"));
        assertFalse(NotificationView.isCurrentDestination(current, target,
                server, "gateway/one/other", "Demo"));
    }

    @Test
    public void notificationClickReusesTasksAndLocalConversationsButNotUnknownPages() {
        String path = "/tasks?project=Demo&task=t";
        assertTrue(NotificationView.isCurrentDestination(server.origin() + path + "&workflow=flow",
                server.origin() + path, server, "", ""));
        assertTrue(NotificationView.isCurrentDestination(server.origin() + "/workspace/one/tasks?project=Demo&task=t",
                server.origin() + "/tasks?project=gateway%2Fone%2Fp&task=t", server, "gateway/one/p", "Demo"));
        assertTrue(NotificationView.isCurrentDestination(server.origin() + "/workspace/one/chat?project=My%20Project&session=s",
                server.origin() + "/workspace/one/chat?session=s&project=My+Project", server, "", ""));
        assertFalse(NotificationView.isCurrentDestination(server.origin() + path,
                "https://other.example.com" + path, server, "", ""));
        assertFalse(NotificationView.isCurrentDestination(server.origin() + "/chat?project=Demo",
                server.origin() + "/chat?project=Demo", server, "", ""));
        assertFalse(NotificationView.isCurrentDestination(null, server.origin() + path, server, "", ""));
    }

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
