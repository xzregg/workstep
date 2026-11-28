package com.workstep.android;

import org.junit.Test;
import static org.junit.Assert.*;

public class LastPageUrlTest {
    @Test public void restoresOnlyDetailsForTheSelectedP2pDevice() {
        String key = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
        P2pConnection device = P2pConnection.parse("https://gateway.test/p2p/device-1/#pair_key=" + key);
        String detail = "https://gateway.test/p2p/device-1/chat?project=demo&session=reply-7";
        assertEquals(detail, LastPageUrl.p2pDetail(device, detail + "#pair_key=" + key));
        assertEquals(detail + "#pair_key=" + key, LastPageUrl.p2pLaunchUrl(device, detail));
        assertEquals("https://gateway.test/p2p/device-1/tasks?project=demo&task=t-1",
                LastPageUrl.p2pDetail(device, "https://gateway.test/p2p/device-1/tasks?project=demo&task=t-1"));
        for (String url : new String[] { null, detail.replace("device-1", "device-12"),
                detail.replace("gateway.test", "other.test"), "https://gateway.test/p2p/device-1/",
                "https://gateway.test/p2p/device-1/chat?project=demo", "https://gateway.test/p2p/device-1/%63hat?project=demo&session=reply-7",
                "https://gateway.test/p2p/device-1/file-preview?project=demo&session=reply-7" }) {
            assertNull(LastPageUrl.p2pDetail(device, url));
            assertEquals(device.pairingUrl(), LastPageUrl.p2pLaunchUrl(device, url));
        }
    }
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
