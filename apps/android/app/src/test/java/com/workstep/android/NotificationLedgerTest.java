package com.workstep.android;

import static org.junit.Assert.*;
import org.junit.Test;
import java.nio.file.Files;
import java.io.File;
import java.util.concurrent.atomic.AtomicInteger;
import java.nio.file.StandardOpenOption;

public class NotificationLedgerTest {
    public static class Worker {
        public static void main(String[] args) throws Exception {
            File directory = new File(args[0]);
            NotificationLedger.deliver(directory, "shared-reply", () -> {
                try {
                    Files.write(new File(directory, "sent.txt").toPath(), new byte[]{1},
                            StandardOpenOption.CREATE, StandardOpenOption.APPEND);
                } catch (Exception error) { throw new RuntimeException(error); }
            });
        }
    }

    @Test(timeout = 15000)
    public void twoProcessesRacingToDeliverAlertOnlyOnce() throws Exception {
        File directory = Files.createTempDirectory("workstep-process-notice").toFile();
        String classpath = new File(NotificationLedger.class.getProtectionDomain().getCodeSource().getLocation().toURI())
                + File.pathSeparator + new File(getClass().getProtectionDomain().getCodeSource().getLocation().toURI());
        ProcessBuilder command = new ProcessBuilder(new File(System.getProperty("java.home"), "bin/java").getPath(),
                "-cp", classpath, Worker.class.getName(), directory.getPath());
        try {
            Process first = command.start();
            Process second = command.start();
            assertEquals(0, first.waitFor());
            assertEquals(0, second.waitFor());
            assertEquals(1, Files.readAllBytes(new File(directory, "sent.txt").toPath()).length);
        } finally {
            new File(directory, "sent.txt").delete();
            new File(directory, "notification-receipts.txt").delete();
            directory.delete();
        }
    }

    @Test
    public void theSameReplyIsDeliveredOnceAcrossCallersAndRestarts() throws Exception {
        File directory = Files.createTempDirectory("workstep-notice").toFile();
        AtomicInteger sent = new AtomicInteger();
        try {
            assertTrue(NotificationLedger.deliver(directory, "server:p:s:m1", sent::incrementAndGet));
            assertFalse(NotificationLedger.deliver(new File(directory.getPath()), "server:p:s:m1", sent::incrementAndGet));
            assertTrue(NotificationLedger.deliver(directory, "server:p:s:m2", sent::incrementAndGet));
            assertEquals(2, sent.get());
        } finally {
            new File(directory, "notification-receipts.txt").delete();
            directory.delete();
        }
    }
}
