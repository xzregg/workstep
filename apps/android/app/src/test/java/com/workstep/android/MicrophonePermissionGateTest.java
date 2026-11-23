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

    @Test public void videoWithSoundRequestsBothPermissionsAndGrantsOnlyAfterConsent() {
        String video = "android.webkit.resource.VIDEO_CAPTURE";
        MicrophonePermissionGate<Object> media = new MicrophonePermissionGate<>(
                new String[]{AUDIO, video}, granted::add, denied::add);
        Object request = new Object();
        assertTrue(media.begin(request, server, server.origin() + "/companion", server.origin(),
                new String[]{video, AUDIO}, false));
        assertTrue(granted.isEmpty());
        media.result(true, server, server.origin() + "/companion");
        assertEquals(List.of(request), granted);
        for (String[] invalid : new String[][]{{}, {AUDIO, AUDIO}, {video, "unknown"}}) {
            Object rejected = new Object();
            assertFalse(media.begin(rejected, server, server.origin(), server.origin(), invalid, true));
            assertTrue(denied.contains(rejected));
        }
    }

    @Test public void mixedCaptureCannotSurviveDenialNavigationOrForeignOrigins() {
        String video = "android.webkit.resource.VIDEO_CAPTURE";
        for (String outcome : new String[]{"denied", "navigation", "background", "cancelled"}) {
            List<Object> accepted = new ArrayList<>(), rejected = new ArrayList<>();
            MicrophonePermissionGate<Object> media = new MicrophonePermissionGate<>(
                    new String[]{AUDIO, video}, accepted::add, rejected::add);
            Object request = new Object();
            assertTrue(media.begin(request, server, server.origin(), server.origin(), new String[]{AUDIO, video}, false));
            if (outcome.equals("background")) media.clear();
            if (outcome.equals("cancelled")) media.cancelled(request);
            media.result(!outcome.equals("denied"), server,
                    outcome.equals("navigation") ? server.origin() + "/chat" : server.origin());
            assertTrue(outcome, accepted.isEmpty());
        }
        MicrophonePermissionGate<Object> media = new MicrophonePermissionGate<>(
                new String[]{AUDIO, video}, granted::add, denied::add);
        assertFalse(media.begin(new Object(), server, server.origin(), "https://other.test", new String[]{AUDIO, video}, true));
        assertTrue(granted.isEmpty());
    }

    @Test public void cameraConsentIsIndependentAndRejectsAudioOrMixedRequests() {
        String video = "android.webkit.resource.VIDEO_CAPTURE";
        MicrophonePermissionGate<Object> camera = new MicrophonePermissionGate<>(video, granted::add, denied::add);
        Object request = new Object();
        assertTrue(camera.begin(request, server, server.origin(), server.origin(), new String[]{video}, false));
        assertTrue(granted.isEmpty());
        camera.result(true, server, server.origin());
        assertEquals(List.of(request), granted);
        assertFalse(camera.begin(new Object(), server, server.origin(), server.origin(), new String[]{AUDIO}, true));
        assertFalse(camera.begin(new Object(), server, server.origin(), server.origin(), new String[]{video, AUDIO}, true));
        assertFalse(camera.begin(new Object(), server, "https://other.test", server.origin(), new String[]{video}, true));
        assertEquals(3, denied.size());
    }

    @Test public void cameraPermissionCannotSurviveDenialCancellationNavigationOrInsecurePages() {
        String video = "android.webkit.resource.VIDEO_CAPTURE";
        for (String outcome : new String[]{"denied", "cancelled", "navigation", "background"}) {
            List<Object> accepted = new ArrayList<>(), rejected = new ArrayList<>();
            MicrophonePermissionGate<Object> camera = new MicrophonePermissionGate<>(video, accepted::add, rejected::add);
            Object request = new Object();
            assertTrue(camera.begin(request, server, server.origin(), server.origin(), new String[]{video}, false));
            if (outcome.equals("cancelled")) camera.cancelled(request);
            if (outcome.equals("background")) camera.clear();
            camera.result(!outcome.equals("denied"), server,
                    outcome.equals("navigation") ? server.origin() + "/chat" : server.origin());
            assertTrue(outcome, accepted.isEmpty());
            assertEquals(outcome, outcome.equals("cancelled") ? 0 : 1, rejected.size());
        }
        MicrophonePermissionGate<Object> camera = new MicrophonePermissionGate<>(video, granted::add, denied::add);
        ServerAddress lan = ServerAddress.parse("http://192.168.1.2:8765");
        assertFalse(camera.begin(new Object(), lan, lan.origin(), lan.origin(), new String[]{video}, true));
        assertTrue(granted.isEmpty());
        Object request = new Object();
        assertFalse(camera.begin(request, server, server.origin(), server.origin(), new String[]{video}, true));
        assertEquals(List.of(request), granted);
    }

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

    @Test public void revokedAppPermissionIsNotInheritedFromAnEarlierGrant() {
        Object first = new Object(), revoked = new Object(), restored = new Object();
        assertFalse(gate.begin(first, server, server.origin(), server.origin(), new String[]{AUDIO}, true));
        assertTrue(gate.begin(revoked, server, server.origin(), server.origin(), new String[]{AUDIO}, false));
        assertEquals(List.of(first), granted);
        gate.result(false, server, server.origin());
        assertEquals(List.of(revoked), denied);
        assertFalse(gate.begin(restored, server, server.origin(), server.origin(), new String[]{AUDIO}, true));
        assertEquals(List.of(first, restored), granted);
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
