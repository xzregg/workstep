package com.workstep.android;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import java.util.function.Supplier;

/** Adapts WebView capture consent to Android's RECORD_AUDIO runtime permission. */
final class MicrophonePermissions {
    private static final int REQUEST_CODE = 1004;
    private final Activity activity;
    private final Supplier<WebView> currentView;
    private final Supplier<ServerAddress> currentServer;
    private final MicrophonePermissionGate<PermissionRequest> gate = new MicrophonePermissionGate<>(
            request -> request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}),
            PermissionRequest::deny);

    MicrophonePermissions(Activity activity, Supplier<WebView> view, Supplier<ServerAddress> server) {
        this.activity = activity;
        currentView = view;
        currentServer = server;
    }

    void request(WebView source, PermissionRequest request) {
        if (source != currentView.get() || !usable()) {
            request.deny();
            return;
        }
        boolean ask = gate.begin(request, currentServer.get(), source.getUrl(),
                request.getOrigin().toString(), request.getResources(),
                activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
        if (ask) {
            try {
                activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_CODE);
            } catch (RuntimeException error) {
                gate.result(false, currentServer.get(), source.getUrl());
            }
        }
    }

    void cancelled(PermissionRequest request) { gate.cancelled(request); }

    boolean result(int code, String[] permissions, int[] results) {
        if (code != REQUEST_CODE) return false;
        boolean granted = permissions.length == 1 && results.length == 1
                && Manifest.permission.RECORD_AUDIO.equals(permissions[0])
                && results[0] == PackageManager.PERMISSION_GRANTED && usable()
                && activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        WebView view = currentView.get();
        gate.result(granted, currentServer.get(), view == null ? null : view.getUrl());
        return true;
    }

    void clear() { gate.clear(); }

    private boolean usable() {
        WebView view = currentView.get();
        return !activity.isFinishing() && !activity.isDestroyed() && view != null
                && view.isAttachedToWindow() && view.getVisibility() == View.VISIBLE;
    }
}
