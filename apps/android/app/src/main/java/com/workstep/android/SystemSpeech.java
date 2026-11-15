package com.workstep.android;

import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import androidx.webkit.JavaScriptReplyProxy;
import org.json.JSONObject;
import java.util.Locale;

/** System TTS, exposed only to the configured service's main frame. */
final class SystemSpeech {
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech engine;
    private boolean ready;
    private boolean closed;
    private String id;
    private JSONObject pending;
    private JavaScriptReplyProxy reply;

    SystemSpeech(Context context) { this.context = context; }

    void handle(String data, JavaScriptReplyProxy callback) {
        if (closed) return;
        try {
            JSONObject message = new JSONObject(data);
            String request = message.optString("id");
            if ("stop".equals(message.optString("type"))) {
                if (request.equals(id)) stop();
                return;
            }
            if (!"speak".equals(message.optString("type")) || request.isEmpty()) return;
            String text = message.optString("text");
            double rate = message.optDouble("rate", 1), volume = message.optDouble("volume", 1);
            if (text.isBlank() || text.length() > 1200 || !Double.isFinite(rate) || rate < .5 || rate > 2
                    || !Double.isFinite(volume) || volume < 0 || volume > 1) {
                respond(callback, request, "语音参数无效"); return;
            }
            if (id != null) { respond(callback, request, "系统语音正在播放，请先停止"); return; }
            id = request; pending = message; reply = callback;
            if (engine == null) {
                engine = new TextToSpeech(context, status -> main.post(() -> initialized(status)));
            } else if (ready) speak();
        } catch (Exception ignored) { /* Invalid bridge input must not affect the host. */ }
    }

    private void initialized(int status) {
        if (closed) return;
        if (status != TextToSpeech.SUCCESS) {
            finish("手机系统语音未就绪，请检查系统文字转语音设置");
            if (engine != null) engine.shutdown();
            engine = null; return;
        }
        ready = true;
        engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) {}
            @Override public void onDone(String utteranceId) { complete(utteranceId, null); }
            @Override public void onError(String utteranceId) { complete(utteranceId, "系统语音播放失败，请检查手机音色与语音引擎"); }
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
            finish("手机未安装中文音色，请在系统文字转语音设置中安装"); return;
        }
        engine.setSpeechRate((float) pending.optDouble("rate", 1));
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, (float) pending.optDouble("volume", 1));
        if (engine.speak(pending.optString("text"), TextToSpeech.QUEUE_FLUSH, params, id) == TextToSpeech.ERROR)
            finish("系统语音无法播放，请检查手机文字转语音设置");
    }

    private static void respond(JavaScriptReplyProxy callback, String id, String error) {
        try {
            JSONObject result = new JSONObject().put("id", id).put("status", error == null ? "done" : "error");
            if (error != null) result.put("error", error);
            callback.postMessage(result.toString());
        } catch (Exception ignored) { /* The requesting frame may have navigated away. */ }
    }

    private void finish(String error) {
        if (reply != null) respond(reply, id, error);
        id = null; pending = null; reply = null;
    }

    void stop() { if (engine != null) engine.stop(); finish(null); }
    void close() { closed = true; stop(); if (engine != null) engine.shutdown(); engine = null; }
}
