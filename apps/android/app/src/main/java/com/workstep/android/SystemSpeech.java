package com.workstep.android;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.MediaDataSource;
import android.media.MediaPlayer;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import androidx.webkit.JavaScriptReplyProxy;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;

/** Native voice output, exposed only to the configured service's main frame. */
final class SystemSpeech {
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech engine;
    private boolean ready;
    private boolean closed;
    private String id;
    private JSONObject pending;
    private JavaScriptReplyProxy reply;
    private MediaPlayer chime;
    private String chimeId;
    private ArrayList<String> greetingRoutes;
    private int greetingDuration;
    private static final int MAX_GREETING_CHARS = 1024 * 1024;

    SystemSpeech(Context context) { this.context = context; }

    void handleWakeGreeting(String data, JavaScriptReplyProxy callback) {
        if (closed || data == null || data.length() > MAX_GREETING_CHARS + 8192) return;
        String request = "";
        try {
            JSONObject message = new JSONObject(data);
            request = message.optString("id");
            if (request.isEmpty()) return;
            String type = message.optString("type");
            if ("stop".equals(type)) {
                if (request.equals(chimeId)) releaseChime();
                return;
            }
            if (!"wake-greeting".equals(type)) return;
            int sampleRate = message.getInt("sampleRate");
            double rate = message.getDouble("rate"), volume = message.getDouble("volume");
            if (sampleRate < 8000 || sampleRate > 48000 || !Double.isFinite(rate) || rate < .5 || rate > 2
                    || !Double.isFinite(volume) || volume < 0 || volume > 1) {
                respond(callback, request, "Invalid wake greeting parameters"); return;
            }
            JSONArray chunks = message.getJSONArray("chunks");
            if (chunks.length() < 1 || chunks.length() > 512) {
                respond(callback, request, "Invalid wake greeting audio"); return;
            }
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            int size = 0;
            for (int i = 0; i < chunks.length(); i++) {
                String encoded = chunks.getString(i);
                size += encoded.length();
                if (size > MAX_GREETING_CHARS) {
                    respond(callback, request, "Wake greeting audio exceeds its size limit"); return;
                }
                pcm.write(Base64.decode(encoded, Base64.DEFAULT));
            }
            if (pcm.size() == 0 || pcm.size() % 2 != 0) {
                respond(callback, request, "Invalid wake greeting PCM"); return;
            }
            startWakeGreeting(request, callback, wave(pcm.toByteArray(), sampleRate), (float) rate, (float) volume);
        } catch (Exception error) {
            if (!request.isEmpty()) respond(callback, request, "Could not load wake greeting");
        }
    }

    static byte[] wave(byte[] pcm, int sampleRate) {
        // Let the media route start and drain outside the audible part of the greeting.
        int opening = sampleRate * 2 * 320 / 1000;
        int ending = sampleRate * 2 * 100 / 1000;
        int length = opening + pcm.length + ending;
        ByteBuffer wav = ByteBuffer.allocate(44 + length).order(ByteOrder.LITTLE_ENDIAN);
        wav.putInt(0x46464952).putInt(36 + length).putInt(0x45564157);
        wav.putInt(0x20746d66).putInt(16).putShort((short) 1).putShort((short) 1);
        wav.putInt(sampleRate).putInt(sampleRate * 2).putShort((short) 2).putShort((short) 16);
        wav.putInt(0x61746164).putInt(length);
        wav.position(44 + opening);
        wav.put(pcm);
        return wav.array();
    }

    private void startWakeGreeting(String request, JavaScriptReplyProxy callback, byte[] audio, float rate, float volume) {
        releaseChime();
        try {
            MediaPlayer player = new MediaPlayer();
            trackWakeMedia(player, request, callback, "Could not play wake greeting");
            greetingRoutes = new ArrayList<>();
            player.addOnRoutingChangedListener(router -> recordGreetingRoute(player), main);
            player.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            player.setDataSource(new MediaDataSource() {
                @Override public long getSize() { return audio.length; }
                @Override public int readAt(long position, byte[] buffer, int offset, int size) {
                    if (size == 0) return 0;
                    if (position < 0 || position >= audio.length) return -1;
                    int copied = Math.min(size, audio.length - (int) position);
                    System.arraycopy(audio, (int) position, buffer, offset, copied);
                    return copied;
                }
                @Override public void close() {}
            });
            player.setOnPreparedListener(prepared -> {
                if (chime != prepared) return;
                try {
                    prepared.setVolume(volume, volume);
                    greetingDuration = prepared.getDuration();
                    if (rate != 1f) prepared.setPlaybackParams(prepared.getPlaybackParams().setSpeed(rate));
                    prepared.start();
                    recordGreetingRoute(prepared);
                    main.postDelayed(() -> recordGreetingRoute(prepared), 150);
                    respondStatus(callback, request, "started", null);
                } catch (RuntimeException error) {
                    releaseChime("启动失败");
                    respond(callback, request, "Could not play wake greeting");
                }
            });
            player.prepareAsync();
        } catch (Exception error) {
            releaseChime("准备失败");
            respond(callback, request, "Could not play wake greeting");
        }
    }

    void handleWakeChime(String data, JavaScriptReplyProxy callback) {
        if (closed) return;
        String request;
        try {
            JSONObject message = new JSONObject(data);
            request = message.optString("id");
            if (request.isEmpty()) return;
            if ("stop".equals(message.optString("type"))) {
                if (request.equals(chimeId)) releaseChime();
                return;
            }
            if (!"wake-chime".equals(message.optString("type"))) return;
        } catch (Exception ignored) { return; }

        releaseChime();
        try {
            AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            MediaPlayer player = MediaPlayer.create(context, R.raw.wake_chime, attributes, 0);
            if (player == null) {
                respond(callback, request, "Could not load wake chime");
                return;
            }
            trackWakeMedia(player, request, callback, "Could not play wake chime");
            player.start();
            respondStatus(callback, request, "started", null);
        } catch (RuntimeException error) {
            releaseChime();
            respond(callback, request, "Could not play wake chime");
        }
    }

    private void trackWakeMedia(MediaPlayer player, String request, JavaScriptReplyProxy callback, String error) {
        chime = player;
        chimeId = request;
        player.setOnCompletionListener(completed -> {
            if (chime != completed) return;
            releaseChime("播完");
            respond(callback, request, null);
        });
        player.setOnErrorListener((failed, what, extra) -> {
            if (chime == failed) {
                releaseChime("错误 " + what + "/" + extra);
                respond(callback, request, error);
            }
            return true;
        });
    }

    private void releaseChime() {
        releaseChime("取消");
    }

    private void recordGreetingRoute(MediaPlayer player) {
        if (chime != player || greetingRoutes == null) return;
        try {
            AudioDeviceInfo device = player.getRoutedDevice();
            if (device == null) return;
            String route = switch (device.getType()) {
                case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE -> "扬声器";
                case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "听筒";
                case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                        AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> "蓝牙";
                case AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                        AudioDeviceInfo.TYPE_USB_HEADSET -> "有线耳机";
                default -> "设备类型 " + device.getType();
            };
            int last = greetingRoutes.size() - 1;
            if (last < 0 || !route.equals(greetingRoutes.get(last))) {
                if (greetingRoutes.size() == 8) greetingRoutes.remove(0);
                greetingRoutes.add(route);
            }
        } catch (IllegalStateException ignored) { /* The route is only available while playing. */ }
    }

    private void releaseChime(String outcome) {
        if (chime != null && greetingRoutes != null) {
            int position;
            try { position = chime.getCurrentPosition(); }
            catch (IllegalStateException ignored) { position = -1; }
            String routes = greetingRoutes.isEmpty() ? "未知" : String.join(" → ", greetingRoutes);
            String event = "唤醒欢迎语（安卓原生）" + outcome + "；输出=" + routes
                    + "；播放位置=" + position + "/" + greetingDuration + " ms";
            CompletableFuture.runAsync(() -> CrashReports.log(context, "网页主进程", event, null));
        }
        greetingRoutes = null;
        greetingDuration = 0;
        if (chime != null) chime.release();
        chime = null;
        chimeId = null;
    }

    void handle(String data, JavaScriptReplyProxy callback) {
        if (closed) return;
        try {
            JSONObject message = new JSONObject(data);
            String request = message.optString("id");
            if ("stop".equals(message.optString("type"))) {
                if (request.equals(id)) stopSpeech();
                return;
            }
            if (!"speak".equals(message.optString("type")) || request.isEmpty()) return;
            String text = message.optString("text");
            double rate = message.optDouble("rate", 1), volume = message.optDouble("volume", 1);
            if (text.isBlank() || text.length() > 1200 || !Double.isFinite(rate) || rate < .5 || rate > 2
                    || !Double.isFinite(volume) || volume < 0 || volume > 1) {
                respond(callback, request, "Invalid speech parameters"); return;
            }
            if (id != null) { respond(callback, request, "Stop the current system speech playback first"); return; }
            id = request; pending = message; reply = callback;
            if (engine == null) {
                engine = new TextToSpeech(context, status -> main.post(() -> initialized(status)));
            } else if (ready) speak();
        } catch (Exception ignored) { /* Invalid bridge input must not affect the host. */ }
    }

    private void initialized(int status) {
        if (closed) return;
        if (status != TextToSpeech.SUCCESS) {
            finish("System speech is unavailable. Check the text-to-speech settings.");
            if (engine != null) engine.shutdown();
            engine = null; return;
        }
        ready = true;
        engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) {}
            @Override public void onDone(String utteranceId) { complete(utteranceId, null); }
            @Override public void onError(String utteranceId) { complete(utteranceId, "System speech playback failed. Check the device voice and speech engine."); }
            @Override public void onStop(String utteranceId, boolean interrupted) { complete(utteranceId, null); }
        });
        if (pending != null) speak();
    }

    private void complete(String utteranceId, String error) {
        main.post(() -> { if (utteranceId.equals(id)) finish(error); });
    }

    private void speak() {
        int language = engine.setLanguage(Locale.SIMPLIFIED_CHINESE);
        if (language == TextToSpeech.LANG_MISSING_DATA || language == TextToSpeech.LANG_NOT_SUPPORTED) {
            finish("Install a Chinese voice in the system text-to-speech settings."); return;
        }
        engine.setSpeechRate((float) pending.optDouble("rate", 1));
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, (float) pending.optDouble("volume", 1));
        if (engine.speak(pending.optString("text"), TextToSpeech.QUEUE_FLUSH, params, id) == TextToSpeech.ERROR)
            finish("Could not play system speech. Check the text-to-speech settings.");
    }

    private static void respond(JavaScriptReplyProxy callback, String id, String error) {
        respondStatus(callback, id, error == null ? "done" : "error", error);
    }

    private static void respondStatus(JavaScriptReplyProxy callback, String id, String status, String error) {
        try {
            JSONObject result = new JSONObject().put("id", id).put("status", status);
            if (error != null) result.put("error", error);
            callback.postMessage(result.toString());
        } catch (Exception ignored) { /* The requesting frame may have navigated away. */ }
    }

    private void finish(String error) {
        if (reply != null) respond(reply, id, error);
        id = null; pending = null; reply = null;
    }

    private void stopSpeech() { if (engine != null) engine.stop(); finish(null); }
    void stop() { releaseChime(); stopSpeech(); }
    void close() { closed = true; stop(); if (engine != null) engine.shutdown(); engine = null; }
}
