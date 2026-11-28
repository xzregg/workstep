package com.workstep.android;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.webkit.JavaScriptReplyProxy;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Receives a workspace download for saving or launching the Android installer. */
final class P2pDownload {
    static final int REQUEST_CODE = 1015;
    private static final int MAX_CHUNK_BYTES = 16 * 1024;
    private final Activity activity;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Runnable pickerStarted;
    private final ApkInstaller apkInstaller;
    private Transfer transfer;
    private boolean picking;

    private static final class Transfer {
        final JavaScriptReplyProxy reply;
        Uri document;
        File apk;
        String apkFilename;
        String apkSaveWarning;
        long bytes;
        OutputStream output;
        boolean writing;

        Transfer(JavaScriptReplyProxy reply) {
            this.reply = reply;
        }
    }

    P2pDownload(Activity activity, Runnable pickerStarted, ApkInstaller apkInstaller) {
        this.activity = activity;
        this.pickerStarted = pickerStarted;
        this.apkInstaller = apkInstaller;
    }

    void handle(String message, JavaScriptReplyProxy reply) {
        try {
            if (message == null || message.length() > MAX_CHUNK_BYTES * 2) throw new IllegalArgumentException();
            JSONObject command = new JSONObject(message);
            switch (command.getString("type")) {
                case "start" -> start(command, reply);
                case "chunk" -> write(command, reply);
                case "finish" -> finish(reply);
                case "abort" -> cancel();
                default -> throw new IllegalArgumentException();
            }
        } catch (Exception error) {
            cancel();
            reply.postMessage(activity.getString(R.string.p2p_download_failed));
        }
    }

    private void start(JSONObject command, JavaScriptReplyProxy reply) throws Exception {
        if (transfer != null || picking) {
            reply.postMessage(activity.getString(R.string.finish_current_save));
            return;
        }
        String name = command.getString("filename").replace('/', '_').replace('\\', '_').trim();
        String mime = command.optString("mime").split(";", 2)[0].trim();
        if (ApkDownloadPolicy.isApk(name, mime)) {
            Transfer current = new Transfer(reply);
            current.apkFilename = name.isEmpty() ? "workstep.apk" : name;
            transfer = current;
            current.writing = true;
            executor.execute(() -> {
                try {
                    current.apk = apkInstaller.createDirectDownload();
                    current.output = new FileOutputStream(current.apk);
                    completeWrite(current, reply, false, true);
                } catch (Exception error) {
                    completeWrite(current, reply, false, false);
                }
            });
            return;
        }
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        save.addCategory(Intent.CATEGORY_OPENABLE);
        save.setType(mime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+") ? mime : "application/octet-stream");
        save.putExtra(Intent.EXTRA_TITLE, name.isEmpty() ? "download" : name);
        activity.startActivityForResult(save, REQUEST_CODE);
        transfer = new Transfer(reply);
        picking = true;
        pickerStarted.run();
    }

    void onResult(int resultCode, Intent result) {
        picking = false;
        Transfer current = transfer;
        if (current == null) return;
        if (resultCode != Activity.RESULT_OK || result == null || result.getData() == null) {
            transfer = null;
            current.reply.postMessage("cancelled");
            return;
        }
        current.document = result.getData();
        current.writing = true;
        executor.execute(() -> {
            try {
                current.output = activity.getContentResolver().openOutputStream(current.document, "w");
                if (current.output == null) throw new IllegalStateException();
                completeWrite(current, current.reply, false, true);
            } catch (Exception error) {
                completeWrite(current, current.reply, false, false);
            }
        });
    }

    private Transfer readyTransfer() {
        Transfer current = transfer;
        if (current == null || current.output == null || current.writing) throw new IllegalStateException();
        current.writing = true;
        return current;
    }

    private void write(JSONObject command, JavaScriptReplyProxy reply) throws Exception {
        byte[] bytes = Base64.decode(command.getString("data"), Base64.DEFAULT);
        if (bytes.length > MAX_CHUNK_BYTES) throw new IllegalArgumentException();
        Transfer current = readyTransfer();
        executor.execute(() -> {
            try {
                if (current.apk != null && current.bytes + bytes.length > ApkInstaller.MAX_APK_BYTES) {
                    throw new IllegalStateException("The APK is too large");
                }
                current.output.write(bytes);
                current.bytes += bytes.length;
                completeWrite(current, reply, false, true);
            } catch (Exception error) {
                completeWrite(current, reply, false, false);
            }
        });
    }

    private void finish(JavaScriptReplyProxy reply) {
        Transfer current = readyTransfer();
        executor.execute(() -> {
            try {
                current.output.close();
                current.output = null;
                if (current.apk != null) {
                    apkInstaller.verifyWorkStepApk(current.apk);
                    current.apkSaveWarning = apkInstaller.saveDownloadedApk(current.apk, current.apkFilename);
                }
                completeWrite(current, reply, true, true);
            } catch (Exception error) {
                completeWrite(current, reply, true, false);
            }
        });
    }

    private void completeWrite(Transfer current, JavaScriptReplyProxy reply, boolean finished, boolean success) {
        activity.runOnUiThread(() -> {
            if (transfer != current) return;
            current.writing = false;
            if (!success) cancel();
            else if (finished) transfer = null;
            reply.postMessage(success ? "ok" : activity.getString(R.string.p2p_download_failed));
            if (success && finished && current.apk != null) {
                apkInstaller.showInstallPrompt(current.apk, current.apkSaveWarning, true);
            }
        });
    }

    void cancel() {
        Transfer current = transfer;
        transfer = null;
        if (current == null) return;
        executor.execute(() -> {
            try {
                if (current.output != null) current.output.close();
            } catch (Exception ignored) {}
            if (current.apk != null) current.apk.delete();
            if (current.document != null) {
                try {
                    DocumentsContract.deleteDocument(activity.getContentResolver(), current.document);
                } catch (Exception ignored) {}
            }
        });
    }

    void dispose() {
        cancel();
        executor.shutdown();
    }
}
