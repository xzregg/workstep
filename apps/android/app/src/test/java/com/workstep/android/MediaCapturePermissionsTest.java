package com.workstep.android;

import static org.junit.Assert.*;
import org.junit.Test;

public class MediaCapturePermissionsTest {
    private static final String AUDIO = "android.webkit.resource.AUDIO_CAPTURE";
    private static final String VIDEO = "android.webkit.resource.VIDEO_CAPTURE";
    private static final String MIC = "android.permission.RECORD_AUDIO";
    private static final String CAMERA = "android.permission.CAMERA";

    @Test public void mapsOnlyRequestedDevicesIncludingVideoWithSound() {
        assertArrayEquals(new String[]{MIC}, MicrophonePermissions.permissionsFor(new String[]{AUDIO}));
        assertArrayEquals(new String[]{CAMERA}, MicrophonePermissions.permissionsFor(new String[]{VIDEO}));
        assertArrayEquals(new String[]{CAMERA, MIC}, MicrophonePermissions.permissionsFor(new String[]{VIDEO, AUDIO}));
        assertNull(MicrophonePermissions.permissionsFor(null));
        assertNull(MicrophonePermissions.permissionsFor(new String[]{}));
        assertNull(MicrophonePermissions.permissionsFor(new String[]{AUDIO, AUDIO}));
        assertNull(MicrophonePermissions.permissionsFor(new String[]{VIDEO, "unknown"}));
    }

    @Test public void partialDenialCancellationAndUnexpectedCallbacksNeverGrant() {
        String[] both = {CAMERA, MIC};
        assertTrue(MicrophonePermissions.allGranted(both, new String[]{MIC, CAMERA}, new int[]{0, 0}));
        assertFalse(MicrophonePermissions.allGranted(both, both, new int[]{0, -1}));
        assertFalse(MicrophonePermissions.allGranted(both, new String[]{CAMERA}, new int[]{0}));
        assertFalse(MicrophonePermissions.allGranted(both, new String[]{}, new int[]{}));
        assertFalse(MicrophonePermissions.allGranted(both, new String[]{MIC, MIC}, new int[]{0, 0}));
        assertFalse(MicrophonePermissions.allGranted(both, both, new int[]{0}));
        assertFalse(MicrophonePermissions.allGranted(new String[]{}, new String[]{}, new int[]{}));
    }
}
