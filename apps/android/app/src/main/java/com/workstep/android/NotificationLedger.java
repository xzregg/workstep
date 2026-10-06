package com.workstep.android;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashSet;

/** The file lock coordinates notification delivery between Android processes. */
final class NotificationLedger {
    static synchronized boolean deliver(File directory, String id, Runnable send) throws IOException {
        String key = Base64.getEncoder().encodeToString(id.getBytes(StandardCharsets.UTF_8));
        try (RandomAccessFile file = new RandomAccessFile(new File(directory, "notification-receipts.txt"), "rw");
             FileLock lock = file.getChannel().lock()) {
            byte[] bytes = new byte[(int) file.length()];
            file.readFully(bytes);
            LinkedHashSet<String> receipts = new LinkedHashSet<>();
            for (String line : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
                if (!line.isEmpty()) receipts.add(line);
            }
            if (receipts.contains(key)) return false;
            send.run();
            receipts.add(key);
            while (receipts.size() > 1000) receipts.remove(receipts.iterator().next());
            file.seek(0);
            file.setLength(0);
            file.write((String.join("\n", receipts) + "\n").getBytes(StandardCharsets.UTF_8));
            file.getFD().sync();
            return true;
        }
    }
}
