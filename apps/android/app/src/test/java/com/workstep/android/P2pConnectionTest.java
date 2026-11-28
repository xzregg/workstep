package com.workstep.android;

import static org.junit.Assert.*;
import org.junit.Test;

public class P2pConnectionTest {
    private static final String KEY = "abcdefghijklmnopqrstuvwxyz123456";

    @Test public void parsesPairingLinkAndKeepsKeyOutOfDisplayAddress() {
        P2pConnection item = P2pConnection.parse("https://Signal.Example/p2p/device-1/#pair_key=" + KEY);
        assertEquals("https://signal.example/p2p/device-1/", item.entryUrl());
        assertEquals("device-1", item.name());
        assertEquals("https://signal.example", item.server().origin());
        assertEquals("https://signal.example/p2p/device-1/#pair_key=" + KEY, item.pairingUrl());
        assertFalse(item.entryUrl().contains(KEY));
    }

    @Test public void rejectsUntrustedOrMalformedLinks() {
        for (String link : new String[]{"https://host/p2p/device/", "https://host/p2p/device/#pair_key=short",
                "https://host/p2p/device/?token=one#pair_key=" + KEY,
                "https://user@host/p2p/device/#pair_key=" + KEY,
                "https://host/other/device/#pair_key=" + KEY,
                "javascript:alert(1)#pair_key=" + KEY,
                "https://host/p2p/device/#pair_key=" + KEY + "&other=1"}) {
            assertThrows(link, IllegalArgumentException.class, () -> P2pConnection.parse(link));
        }
    }
}
