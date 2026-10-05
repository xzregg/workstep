package com.workstep.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ApkDownloadPolicyTest {
    @Test
    public void interceptsApksAndLeavesOtherDownloadsAlone() {
        assertTrue(ApkDownloadPolicy.isApk("app-debug.apk", "application/octet-stream"));
        assertTrue(ApkDownloadPolicy.isApk("WorkStep.APK", null));
        assertTrue(ApkDownloadPolicy.isApk("download", "application/vnd.android.package-archive"));
        assertFalse(ApkDownloadPolicy.isApk("report.pdf", "application/pdf"));
        assertFalse(ApkDownloadPolicy.isApk("notes.txt", "text/plain"));
    }
}
