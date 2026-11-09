package com.workstep.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.function.Consumer;

/** One pending page request, bound to the configured service and its document. */
final class MicrophonePermissionGate<T> {
    private static final String AUDIO = "android.webkit.resource.AUDIO_CAPTURE";
    private final Consumer<T> grant;
    private final Consumer<T> deny;
    private T pending;
    private String origin;
    private String document;
    private boolean androidDialogOpen;

    MicrophonePermissionGate(Consumer<T> grant, Consumer<T> deny) {
        this.grant = grant;
        this.deny = deny;
    }

    /** Returns true only when the host must show the Android runtime dialog. */
    boolean begin(T request, ServerAddress server, String page, String requestingOrigin,
            String[] resources, boolean appPermissionGranted) {
        if (androidDialogOpen || pending != null || !trusted(server, page, requestingOrigin)
                || resources == null || resources.length != 1 || !AUDIO.equals(resources[0])) {
            deny.accept(request);
            return false;
        }
        if (appPermissionGranted) {
            grant.accept(request);
            return false;
        }
        pending = request;
        origin = requestingOrigin;
        document = page;
        androidDialogOpen = true;
        return true;
    }

    void result(boolean granted, ServerAddress server, String page) {
        androidDialogOpen = false;
        T request = pending;
        pending = null;
        if (request == null) return;
        if (granted && document.equals(page) && trusted(server, page, origin)) grant.accept(request);
        else deny.accept(request);
        origin = null;
        document = null;
    }

    void cancelled(T request) {
        if (pending == request) {
            pending = null;
            origin = null;
            document = null;
        }
        // The Android dialog may still return. Do not attach its result to a
        // later request, even if the browser cancelled this one already.
    }

    void clear() {
        T request = pending;
        pending = null;
        origin = null;
        document = null;
        if (request != null) deny.accept(request);
    }

    private static boolean trusted(ServerAddress server, String page, String origin) {
        if (server == null || page == null || origin == null || !server.contains(page) || !server.contains(origin)) return false;
        try {
            URI uri = new URI(server.origin());
            String host = uri.getHost();
            return "https".equals(uri.getScheme()) || "localhost".equalsIgnoreCase(host)
                    || "127.0.0.1".equals(host) || "[::1]".equals(host) || "::1".equals(host);
        } catch (URISyntaxException error) {
            return false;
        }
    }
}
