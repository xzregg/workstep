package com.workstep.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A P2P browser entry and its pairing secret; only entryUrl is safe to display. */
final class P2pConnection {
    private static final Pattern PATH = Pattern.compile("^/p2p/([A-Za-z0-9._~-]+)/?$");
    private static final Pattern FRAGMENT = Pattern.compile("^pair_key=([A-Za-z0-9_-]{24,128})$");
    private final String entryUrl;
    private final String name;
    private final String key;
    private final ServerAddress server;

    private P2pConnection(String entryUrl, String name, String key, ServerAddress server) {
        this.entryUrl = entryUrl;
        this.name = name;
        this.key = key;
        this.server = server;
    }

    static P2pConnection parse(String input) {
        try {
            URI uri = new URI(input.trim());
            Matcher path = PATH.matcher(uri.getRawPath() == null ? "" : uri.getRawPath());
            Matcher fragment = FRAGMENT.matcher(uri.getRawFragment() == null ? "" : uri.getRawFragment());
            if (uri.getRawQuery() != null || uri.getRawUserInfo() != null || !path.matches()
                    || !fragment.matches()) throw new IllegalArgumentException("无效的 P2P 配对链接");
            ServerAddress server = ServerAddress.parse(uri.getScheme() + "://" + uri.getRawAuthority());
            String name = path.group(1);
            return new P2pConnection(server.origin() + "/p2p/" + name + "/", name,
                    fragment.group(1), server);
        } catch (NullPointerException | URISyntaxException error) {
            throw new IllegalArgumentException("无效的 P2P 配对链接", error);
        }
    }

    String entryUrl() { return entryUrl; }
    String name() { return name; }
    String key() { return key; }
    String pairingUrl() { return entryUrl + "#pair_key=" + key; }
    ServerAddress server() { return server; }
}
