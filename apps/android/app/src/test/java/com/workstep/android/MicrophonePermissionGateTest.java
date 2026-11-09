package com.workstep.android;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class MicrophonePermissionGateTest {
    private static final String AUDIO = "android.webkit.resource.AUDIO_CAPTURE";
    private final ServerAddress server = ServerAddress.parse("https://workstep.test");
    private final List<Object> granted = new ArrayList<>();
    private final List<Object> denied = new ArrayList<>();
    private final MicrophonePermissionGate<Object> gate = new MicrophonePermissionGate<>(granted::add, denied::add);

    @Test public void requestsAndroidPermissionBeforeGrantingThePage() {
        Object request = new Object();
        assertTrue(gate.begin(request, server, "https://workstep.test/chat", "https://workstep.test/", new String[]{AUDIO}, false));
        assertTrue(granted.isEmpty());
        gate.result(true, server, "https://workstep.test/chat");
        assertEquals(List.of(request), granted);
        gate.result(true, server, "https://workstep.test/chat");
        assertEquals(1, granted.size());
    }

    @Test public void existingAppPermissionGrantsOnlyAudio() {
        Object request = new Object();
        assertFalse(gate.begin(request, server, "https://workstep.test/chat", server.origin(), new String[]{AUDIO}, true));
        assertEquals(List.of(request), granted);
    }

    @Test public void rejectsCameraUnknownResourcesAndForeignOrigins() {
        for (String[] resources : new String[][]{ {}, {"android.webkit.resource.VIDEO_CAPTURE"}, {AUDIO, "unknown"}, {AUDIO, AUDIO}}) {
            Object request = new Object();
            assertFalse(gate.begin(request, server, server.origin(), server.origin(), resources, true));
            assertTrue(denied.contains(request));
        }
        for (String origin : new String[]{"https://other.test", "https://workstep.test.evil", "http://workstep.test", "https://workstep.test:8443"}) {
            Object request = new Object();
            assertFalse(gate.begin(request, server, server.origin(), origin, new String[]{AUDIO}, true));
            assertTrue(denied.contains(request));
        }
        assertTrue(granted.isEmpty());
    }

    @Test public void loginPagesCannotBorrowWorkStepMicrophonePermission() {
        Object request = new Object();
        assertFalse(gate.begin(request, server, "https://login.dingtalk.com", server.origin(), new String[]{AUDIO}, true));
        assertEquals(List.of(request), denied);
    }

    @Test public void denialAndEmptyAndroidResultsNeverGrant() {
        Object request = new Object();
        gate.begin(request, server, server.origin(), server.origin(), new String[]{AUDIO}, false);
        gate.result(false, server, server.origin());
        assertEquals(List.of(request), denied);
        assertTrue(granted.isEmpty());
    }

    @Test public void navigationOrBackgroundInvalidatesPendingPermission() {
        Object request = new Object();
        gate.begin(request, server, server.origin(), server.origin(), new String[]{AUDIO}, false);
        gate.clear();
        gate.result(true, server, server.origin());
        assertEquals(List.of(request), denied);
        assertTrue(granted.isEmpty());
    }

    @Test public void switchingHostWhileSystemDialogIsOpenNeverGrants() {
        Object request = new Object();
        gate.begin(request, server, server.origin(), server.origin(), new String[]{AUDIO}, false);
        gate.result(true, ServerAddress.parse("https://other.test"), "https://other.test/chat");
        assertEquals(List.of(request), denied);
    }

    @Test public void cancelledRequestIsForgottenAndCannotBeReplacedDuringTheSystemDialog() {
        Object first = new Object(), second = new Object();
        gate.begin(first, server, server.origin(), server.origin(), new String[]{AUDIO}, false);
        gate.cancelled(first);
        assertFalse(gate.begin(second, server, server.origin(), server.origin(), new String[]{AUDIO}, false));
        gate.result(true, server, server.origin());
        assertTrue(granted.isEmpty());
        assertEquals(List.of(second), denied); // Do not invoke a cancelled WebView request.
    }

    @Test public void insecureLanPagesCannotGainMicrophoneThroughNativePermission() {
        ServerAddress lan = ServerAddress.parse("http://192.168.1.2:8765");
        Object request = new Object();
        assertFalse(gate.begin(request, lan, lan.origin(), lan.origin(), new String[]{AUDIO}, true));
        assertEquals(List.of(request), denied);
    }
}
