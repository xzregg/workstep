package com.workstep.android;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import java.util.function.Supplier;

/** Adapts trusted WebView audio/video capture to Android runtime consent. */
final class MicrophonePermissions {
    private static final int REQUEST_CODE = 1004;
    private static final int CAMERA_REQUEST_CODE = 1005;
    private int requestingCode;
    private final Activity activity;
    private final Supplier<WebView> currentView;
    private final Supplier<ServerAddress> currentServer;
    private String[] requestedPermissions = new String[0];
    private String[] missingPermissions = new String[0];
    private final MicrophonePermissionGate<PermissionRequest> gate = new MicrophonePermissionGate<>(
            new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE, PermissionRequest.RESOURCE_VIDEO_CAPTURE},
            request -> request.grant(request.getResources()), PermissionRequest::deny);

    MicrophonePermissions(Activity activity, Supplier<WebView> view, Supplier<ServerAddress> server) {
        this.activity = activity;
        currentView = view;
        currentServer = server;
    }

    void request(WebView source, PermissionRequest request) {
        if (source != currentView.get() || !usable() || requestingCode != 0) {
            request.deny();
            return;
        }
        String[] required = permissionsFor(request.getResources());
        if (required == null) { request.deny(); return; }
        String[] missing = java.util.Arrays.stream(required)
                .filter(permission -> activity.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED)
                .toArray(String[]::new);
        boolean ask = gate.begin(request, currentServer.get(), source.getUrl(),
                request.getOrigin().toString(), request.getResources(), missing.length == 0);
        if (ask) {
            int code = required.length == 1 && Manifest.permission.CAMERA.equals(required[0])
                    ? CAMERA_REQUEST_CODE : REQUEST_CODE;
            requestingCode = code;
            requestedPermissions = required;
            missingPermissions = missing;
            try {
                activity.requestPermissions(missing, code);
            } catch (RuntimeException error) {
                requestingCode = 0;
                requestedPermissions = missingPermissions = new String[0];
                gate.result(false, currentServer.get(), source.getUrl());
            }
        }
    }

    /** No unknown resource can borrow capture consent; request exactly the needed OS permissions. */
    static String[] permissionsFor(String[] resources) {
        if (resources == null || resources.length == 0) return null;
        java.util.LinkedHashSet<String> permissions = new java.util.LinkedHashSet<>();
        for (String resource : resources) {
            String permission;
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) permission = Manifest.permission.RECORD_AUDIO;
            else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) permission = Manifest.permission.CAMERA;
            else return null;
            if (!permissions.add(permission)) return null;
        }
        return permissions.toArray(new String[0]);
    }

    static boolean allGranted(String[] expected, String[] permissions, int[] results) {
        if (expected.length == 0 || permissions.length != expected.length || results.length != expected.length) return false;
        java.util.Set<String> remaining = new java.util.HashSet<>(java.util.Arrays.asList(expected));
        for (int i = 0; i < permissions.length; i++) {
            if (!remaining.remove(permissions[i]) || results[i] != PackageManager.PERMISSION_GRANTED) return false;
        }
        return remaining.isEmpty();
    }

    void cancelled(PermissionRequest request) { gate.cancelled(request); }

    boolean result(int code, String[] permissions, int[] results) {
        if (code != REQUEST_CODE && code != CAMERA_REQUEST_CODE) return false;
        if (code != requestingCode) return true;
        requestingCode = 0;
        boolean granted = allGranted(missingPermissions, permissions, results) && usable();
        for (String permission : requestedPermissions) {
            granted &= activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
        }
        requestedPermissions = missingPermissions = new String[0];
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
