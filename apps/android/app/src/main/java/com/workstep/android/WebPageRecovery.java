package com.workstep.android;

import java.net.URI;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Native recovery must remain available when the device's web bundle cannot run. */
final class WebPageRecovery {
    private static final Pattern ERROR_KIND = Pattern.compile("\\b(TypeError|SyntaxError|ReferenceError|RangeError|URIError|EvalError)\\b");

    static boolean needsRootCheck(ServerAddress server, String url) {
        if (server == null || url == null || !server.contains(url)) return false;
        String path = sourcePath(url);
        return path.matches("/(chat|tasks)/?")
                || path.matches("/workspace/[^/]+(?:/(?:chat|tasks)?)?");
    }

    static String devicePicker(ServerAddress server, String url) {
        if (server == null || url == null || !server.contains(url)) return null;
        return sourcePath(url).matches("/workspace/[^/]+(?:/.*)?") ? server.origin() + "/devices" : null;
    }

    static String sourcePath(String source) {
        if (source == null || source.isEmpty()) return "[未知来源]";
        try {
            URI uri = new URI(source);
            if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) return "[非网页来源]";
            String path = uri.getRawPath();
            return path == null || path.isEmpty() ? "/" : path.substring(0, Math.min(path.length(), 512));
        } catch (Exception ignored) {
            return "[未知来源]";
        }
    }

    // Console text can contain chat bodies, request payloads and credentials. Only emit known signatures.
    static String consoleSummary(String message) {
        if (message == null) return "控制台错误（原文未记录）";
        String sample = message.substring(0, Math.min(message.length(), 4096));
        if (sample.contains("Failed to fetch dynamically imported module") || sample.contains("Loading chunk")
                || sample.contains("Importing a module script failed")) return "动态模块加载失败";
        if (sample.contains("Failed to load module script")) return "模块脚本加载失败";
        if (sample.contains("Content Security Policy")) return "内容安全策略拦截";
        Matcher kind = ERROR_KIND.matcher(sample);
        return kind.find() ? kind.group(1) : "控制台错误（原文未记录）";
    }

    private WebPageRecovery() { }
}
