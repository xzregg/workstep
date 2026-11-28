package com.workstep.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Environment;
import android.provider.Settings;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;

/** Verifies WorkStep APK downloads and opens the Android installer after confirmation. */
final class ApkInstaller {
    static final int INSTALL_PERMISSION_REQUEST = 1004;
    static final long MAX_APK_BYTES = 512L * 1024 * 1024;
    private final Activity activity;
    private final ExecutorService executor;
    private final Runnable externalActivityStarted;
    private boolean downloading;
    private AlertDialog progress;
    private File pendingInstall;
    private File lastDirectApk;

    ApkInstaller(Activity activity, ExecutorService executor, Runnable externalActivityStarted) {
        this.activity = activity;
        this.executor = executor;
        this.externalActivityStarted = externalActivityStarted;
    }

    void download(ServerAddress server, String url, String userAgent, String filename) {
        if (downloading) {
            Toast.makeText(activity, "APK 正在下载", Toast.LENGTH_SHORT).show();
            return;
        }
        downloading = true;
        String cookie = CookieManager.getInstance().getCookie(url);
        FrameLayout container = new FrameLayout(activity);
        int padding = Math.round(24 * activity.getResources().getDisplayMetrics().density);
        container.setPadding(padding, padding, padding, padding);
        ProgressBar spinner = new ProgressBar(activity);
        container.addView(spinner, new FrameLayout.LayoutParams(-2, -2, android.view.Gravity.CENTER));
        progress = new AlertDialog.Builder(activity)
                .setTitle("正在下载 WorkStep APK")
                .setView(container)
                .setCancelable(false)
                .show();
        executor.execute(() -> {
            File apk = null;
            String failure = null;
            String saveWarning = null;
            try {
                apk = downloadAndVerify(server, url, userAgent, cookie);
                saveWarning = saveDownloadedApk(apk, filename);
            } catch (Exception error) {
                failure = error.getLocalizedMessage();
                CrashReports.log(activity, "网页主进程", "APK 下载或校验失败", error);
            }
            File ready = apk;
            String message = failure;
            String warning = saveWarning;
            activity.runOnUiThread(() -> {
                downloading = false;
                if (progress != null) progress.dismiss();
                progress = null;
                if (activity.isFinishing() || activity.isDestroyed()) return;
                if (message != null) {
                    new AlertDialog.Builder(activity).setTitle(activity.getString(R.string.apk_download_failed))
                            .setMessage(message).setPositiveButton("确定", null).show();
                } else if (ready != null) {
                    showInstallPrompt(ready, warning, false);
                }
            });
        });
    }

    String saveDownloadedApk(File apk, String filename) {
        try {
            saveToDownloads(apk, filename);
            return null;
        } catch (Exception error) {
            CrashReports.log(activity, "网页主进程", "APK 保存到下载目录失败", error);
            return activity.getString(R.string.apk_save_warning);
        }
    }

    private void saveToDownloads(File apk, String filename) throws Exception {
        String name = filename.toLowerCase(java.util.Locale.ROOT).endsWith(".apk")
                ? filename : filename + ".apk";
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "application/vnd.android.package-archive");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/");
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri destination = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (destination == null) throw new IllegalStateException("Could not save to Downloads");
        try {
            try (InputStream input = new java.io.FileInputStream(apk);
                 OutputStream output = activity.getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IllegalStateException("Could not write to Downloads");
                byte[] buffer = new byte[16384];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
            activity.getContentResolver().update(destination, ready, null, null);
        } catch (Exception error) {
            activity.getContentResolver().delete(destination, null, null);
            throw error;
        }
    }

    private File downloadAndVerify(ServerAddress server, String url, String userAgent, String cookie) throws Exception {
        File directory = new File(activity.getCacheDir(), "install");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Could not create the download cache");
        File partial = new File(directory, "workstep-update.part");
        File apk = new File(directory, "workstep-update.apk");
        try {
            String address = url;
            for (int redirects = 0; redirects <= 5; redirects++) {
                HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
                try {
                    connection.setConnectTimeout(15000);
                    connection.setReadTimeout(30000);
                    connection.setInstanceFollowRedirects(false);
                    if (userAgent != null && !userAgent.isEmpty()) connection.setRequestProperty("User-Agent", userAgent);
                    if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
                    int status = connection.getResponseCode();
                    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                        String location = connection.getHeaderField("Location");
                        if (location == null) throw new IllegalStateException("The server did not provide a download location");
                        address = server.resolveSameOrigin(address, location);
                        continue;
                    }
                    if (status != 200) throw new IllegalStateException("The server returned HTTP " + status);
                    long bytes = 0;
                    try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                        byte[] buffer = new byte[16384];
                        int count;
                        while ((count = input.read(buffer)) != -1) {
                            bytes += count;
                            if (bytes > MAX_APK_BYTES) throw new IllegalStateException("The APK is too large");
                            output.write(buffer, 0, count);
                        }
                    }
                    if (bytes == 0) throw new IllegalStateException("The APK is empty");
                    if (apk.exists() && !apk.delete()) throw new IllegalStateException("Could not replace the previous download");
                    if (!partial.renameTo(apk)) throw new IllegalStateException("Could not save the APK");
                    verifyWorkStepApk(apk);
                    CrashReports.log(activity, "网页主进程", "WorkStep APK 下载完成；字节=" + bytes, null);
                    return apk;
                } finally {
                    connection.disconnect();
                }
            }
            throw new IllegalStateException("Too many download redirects");
        } catch (Exception error) {
            if (partial.exists()) partial.delete();
            if (apk.exists()) apk.delete();
            throw error;
        }
    }

    File createDirectDownload() throws Exception {
        File directory = new File(activity.getCacheDir(), "install");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("Could not create the download cache");
        return File.createTempFile("workstep-direct-", ".apk", directory);
    }

    void verifyWorkStepApk(File apk) {
        PackageInfo archive = activity.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
        if (archive == null || !activity.getPackageName().equals(archive.packageName)) {
            throw new IllegalStateException("The downloaded file is not a WorkStep APK");
        }
    }

    void showInstallPrompt(File apk, String warning, boolean direct) {
        if (activity.isFinishing() || activity.isDestroyed()) {
            if (direct) executor.execute(apk::delete);
            return;
        }
        AlertDialog prompt = new AlertDialog.Builder(activity)
                .setTitle("安装 WorkStep")
                .setMessage((warning == null ? "APK 已保存到下载目录。" : warning)
                        + "是否打开系统安装界面？")
                .setNegativeButton("取消", null)
                .setPositiveButton("安装", (dialog, which) -> {
                    if (direct) {
                        ((AlertDialog) dialog).setOnDismissListener(null);
                        File previous = lastDirectApk;
                        lastDirectApk = apk;
                        if (previous != null) executor.execute(previous::delete);
                    }
                    install(apk);
                })
                .create();
        if (direct) prompt.setOnDismissListener(dialog -> {
            if (!executor.isShutdown()) executor.execute(apk::delete);
        });
        prompt.show();
    }

    private void install(File apk) {
        pendingInstall = apk;
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName()));
                activity.startActivityForResult(settings, INSTALL_PERMISSION_REQUEST);
                externalActivityStarted.run();
            } catch (Exception error) {
                CrashReports.log(activity, "网页主进程", "无法打开安装权限设置", error);
                Toast.makeText(activity, "请在系统设置允许 WorkStep 安装应用", Toast.LENGTH_LONG).show();
            }
            return;
        }
        openSystemInstaller(apk);
    }

    boolean onActivityResult(int requestCode) {
        if (requestCode != INSTALL_PERMISSION_REQUEST) return false;
        File apk = pendingInstall;
        if (apk != null && apk.exists()) {
            if (activity.getPackageManager().canRequestPackageInstalls()) openSystemInstaller(apk);
            else Toast.makeText(activity, activity.getString(R.string.apk_install_permission), Toast.LENGTH_LONG).show();
        }
        return true;
    }

    private void openSystemInstaller(File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(activity,
                    activity.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.setClipData(ClipData.newUri(activity.getContentResolver(), "WorkStep APK", uri));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(intent);
            externalActivityStarted.run();
            CrashReports.log(activity, "网页主进程", "已打开系统 APK 安装器", null);
        } catch (Exception error) {
            CrashReports.log(activity, "网页主进程", "系统 APK 安装器启动失败", error);
            Toast.makeText(activity, activity.getString(R.string.apk_installer_failed, error.getLocalizedMessage()), Toast.LENGTH_LONG).show();
        }
    }

    void dispose() {
        if (progress != null) progress.dismiss();
        progress = null;
    }
}
