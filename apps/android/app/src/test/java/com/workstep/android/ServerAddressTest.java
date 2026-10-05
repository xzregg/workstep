package com.workstep.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class ServerAddressTest {
    @Test
    public void normalizesHttpsOrigin() {
        assertEquals("https://workstep.example.com", ServerAddress.parse("  https://workstep.example.com/  ").origin());
        assertEquals("https://workstep.example.com:9443", ServerAddress.parse("https://workstep.example.com:9443").origin());
    }

    @Test
    public void acceptsHttpAndRejectsNonRootAddresses() {
        assertEquals("http://workstep.example.com", ServerAddress.parse("http://workstep.example.com").origin());
        assertEquals("http://192.168.1.10:8765", ServerAddress.parse("http://192.168.1.10:8765/").origin());
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.parse("https://workstep.example.com/app"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.parse("https://user:pass@workstep.example.com"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.parse("https://workstep.example.com?token=secret"));
    }

    @Test
    public void keepsOnlySameOriginPagesInsideApp() {
        ServerAddress server = ServerAddress.parse("https://workstep.example.com");
        assertEquals(true, server.contains("https://workstep.example.com/tasks?id=1"));
        assertEquals(false, server.contains("https://other.example.com/tasks"));
        assertEquals(false, server.contains("http://workstep.example.com/tasks"));
        assertEquals(false, server.contains("https://workstep.example.com.evil.test/file"));
        ServerAddress http = ServerAddress.parse("http://192.168.1.10:8765");
        assertEquals(true, http.contains("http://192.168.1.10:8765/tasks"));
        assertEquals(false, http.contains("https://192.168.1.10:8765/tasks"));
    }

    @Test
    public void restoresLastPageOnlyForCurrentServer() {
        ServerAddress server = ServerAddress.parse("https://workstep.example.com");
        String page = "https://workstep.example.com/tasks/42?tab=chat#latest";
        assertEquals(page, server.pageOrRoot(page));
        assertEquals("https://workstep.example.com/", server.pageOrRoot("https://other.example.com/tasks/42"));
        assertEquals("https://workstep.example.com/", server.pageOrRoot("not a URL"));
        assertEquals("https://workstep.example.com/", server.pageOrRoot(null));
    }

    @Test
    public void resolvesOnlySameOriginDownloadRedirects() {
        ServerAddress server = ServerAddress.parse("https://workstep.example.com");
        assertEquals("https://workstep.example.com/api/fs/file?id=1",
                server.resolveSameOrigin("https://workstep.example.com/api/fs/start", "file?id=1"));
        assertThrows(IllegalArgumentException.class, () -> server.resolveSameOrigin(
                "https://workstep.example.com/api/fs/start", "https://elsewhere.test/file"));
        assertThrows(IllegalArgumentException.class, () -> server.resolveSameOrigin(
                "https://workstep.example.com/api/fs/start", "http://workstep.example.com/file"));
    }
}
