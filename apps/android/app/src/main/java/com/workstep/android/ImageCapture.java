package com.workstep.android;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.MediaStore;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.IOException;

/** Owns the temporary full-resolution image until WebView has consumed its URI. */
final class ImageCapture {
    static final int PERMISSION_REQUEST = 1006;
    private final Activity activity;
    private final int resultRequest;
    private final Runnable cancelled;
    private File photo;
    private Uri uri;
    private boolean waitingForPermission;

    ImageCapture(Activity activity, int resultRequest, Runnable cancelled) {
        this.activity = activity;
        this.resultRequest = resultRequest;
        this.cancelled = cancelled;
    }

    void start() {
        clear();
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            waitingForPermission = true;
            activity.requestPermissions(new String[]{Manifest.permission.CAMERA}, PERMISSION_REQUEST);
        } else launch();
    }

    void permissionResult(String[] permissions, int[] results) {
        if (!waitingForPermission) return;
        waitingForPermission = false;
        if (permissions.length == 1 && results.length == 1
                && Manifest.permission.CAMERA.equals(permissions[0])
                && results[0] == PackageManager.PERMISSION_GRANTED
                && activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launch();
        else {
            Toast.makeText(activity, activity.getString(R.string.camera_permission_denied), Toast.LENGTH_LONG).show();
            cancelled.run();
        }
    }

    private void launch() {
        try {
            File directory = new File(activity.getCacheDir(), "image-capture");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("capture directory unavailable");
            // Also remove abandoned captures after an activity/process restart.
            File[] previous = directory.listFiles();
            if (previous != null) for (File file : previous) file.delete();
            photo = File.createTempFile("photo-", ".jpg", directory);
            uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", photo);
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            camera.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            camera.setClipData(ClipData.newRawUri("photo", uri));
            camera.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            activity.startActivityForResult(camera, resultRequest);
        } catch (Exception error) {
            clear();
            Toast.makeText(activity, activity.getString(R.string.camera_open_failed), Toast.LENGTH_LONG).show();
            cancelled.run();
        }
    }

    static boolean hasImage(boolean success, File photo) {
        return success && photo != null && photo.isFile() && photo.length() > 0;
    }

    Uri[] result(boolean success) {
        if (hasImage(success, photo) && uri != null) return new Uri[]{uri};
        clear();
        return null;
    }

    void clear() {
        waitingForPermission = false;
        if (photo != null) photo.delete();
        photo = null;
        uri = null;
    }
}
