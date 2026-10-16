package com.workstep.android;

import org.junit.Test;
import static org.junit.Assert.*;

public class LastPageUrlTest {
    private final ServerAddress server = ServerAddress.parse("https://gateway.test");

    @Test public void remembersOnlyConversationAndTaskDetailsOnTheConfiguredServer() {
        assertTrue(LastPageUrl.shouldRemember(server,
                "https://gateway.test/workspace/device-2/chat?project=demo&session=reply-7"));
        assertTrue(LastPageUrl.shouldRemember(server,
                "https://gateway.test/tasks?project=demo&task=task-3"));
        assertFalse(LastPageUrl.shouldRemember(server, "https://gateway.test/"));
        assertFalse(LastPageUrl.shouldRemember(server, "https://gateway.test/workspace/device-1/chat?project=demo"));
        assertFalse(LastPageUrl.shouldRemember(server, "https://other.test/chat?session=reply-7"));
    }
}
