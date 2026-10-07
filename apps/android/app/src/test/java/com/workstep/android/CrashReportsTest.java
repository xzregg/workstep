package com.workstep.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.nio.file.Files;

public class CrashReportsTest {
    @Test
    public void clearsOnlyWorkStepLogs() throws Exception {
        File directory = Files.createTempDirectory("workstep-logs").toFile();
        File main = new File(directory, "main-log.txt");
        File notification = new File(directory, "notification-log.txt");
        File crash = new File(directory, "last-crash.txt");
        File unrelated = new File(directory, "settings.txt");
        try {
            assertTrue(main.createNewFile());
            assertTrue(notification.createNewFile());
            assertTrue(crash.createNewFile());
            assertTrue(unrelated.createNewFile());

            assertTrue(CrashReports.clearFiles(directory));

            assertFalse(main.exists());
            assertFalse(notification.exists());
            assertFalse(crash.exists());
            assertTrue(unrelated.exists());
            assertTrue(CrashReports.clearFiles(directory));
        } finally {
            main.delete();
            notification.delete();
            crash.delete();
            unrelated.delete();
            directory.delete();
        }
    }

}
