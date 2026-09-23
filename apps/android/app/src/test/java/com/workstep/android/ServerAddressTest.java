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
    public void rejectsInsecureOrNonRootAddresses() {
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.parse("http://workstep.example.com"));
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
