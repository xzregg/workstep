package com.workstep.android;

import java.util.ArrayList;
import java.util.List;

/** Normalized local list of server origins; the active origin is migrated from older installs. */
final class SavedServerAddresses {
    private SavedServerAddresses() {}

    static List<String> load(String stored, String active) {
        List<String> addresses = new ArrayList<>();
        append(addresses, active);
        if (stored != null) {
            for (String item : stored.split("\n")) append(addresses, item);
        }
        return addresses;
    }

    static List<String> add(List<String> addresses, String input) {
        List<String> updated = new ArrayList<>(addresses);
        append(updated, input);
        return updated;
    }

    static List<String> remove(List<String> addresses, String input) {
        List<String> updated = new ArrayList<>(addresses);
        updated.remove(ServerAddress.parse(input).origin());
        return updated;
    }

    static String store(List<String> addresses) {
        return String.join("\n", addresses);
    }

    private static void append(List<String> addresses, String input) {
        if (input == null || input.isEmpty()) return;
        try {
            String origin = ServerAddress.parse(input).origin();
            if (!addresses.contains(origin)) addresses.add(origin);
        } catch (IllegalArgumentException ignored) {
            // Ignore invalid entries left by a prior version or manual preference edits.
        }
    }
}
