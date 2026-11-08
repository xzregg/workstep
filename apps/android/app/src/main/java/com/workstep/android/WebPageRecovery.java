package com.workstep.android;

import java.net.URI;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Native recovery must remain available when the device's web bundle cannot run. */
final class WebPageRecovery {
    private static final Pattern ERROR_KIND = Pattern.compile("\\b(TypeError|SyntaxError|ReferenceError|RangeError|URIError|EvalError)\\b");
    private static final Pattern CSP_DIRECTIVE = Pattern.compile(
            "Content Security Policy directive: [\"']((?:default|script|style|img|font|connect|media|object|frame|child|worker|manifest)-src(?:-elem|-attr)?|frame-ancestors|base-uri|form-action|sandbox|trusted-types|require-trusted-types-for)(?=[\\s\"'])");
    private static final Pattern CSP_RESOURCE = Pattern.compile(
            "(?:Refused to (?:connect to|load the (?:script|image|stylesheet|font|media resource)|frame)|(?:Loading|Connecting to|Framing)(?: the (?:script|image|stylesheet|font|media resource))?) ['\"]([^'\"]+)['\"]");

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
        if (sample.contains("Content Security Policy")) return cspSummary(sample);
        Matcher kind = ERROR_KIND.matcher(sample);
        return kind.find() ? kind.group(1) : "控制台错误（原文未记录）";
    }

    private static String cspSummary(String sample) {
        Matcher directive = CSP_DIRECTIVE.matcher(sample);
        String summary = (sample.contains("[Report Only]")
                ? "内容安全策略报告（未强制拦截）" : "内容安全策略拦截")
                + "；规则=" + (directive.find() ? directive.group(1) : "未知");
        if (sample.contains("inline script")) summary += "；操作=内联脚本";
        else if (sample.contains("inline style")) summary += "；操作=内联样式";
        else if (sample.contains("evaluate a string") || sample.contains("Evaluating a string")) summary += "；操作=动态脚本执行";
        else if (sample.contains("connect to") || sample.contains("Connecting to")) summary += "；操作=网络连接";
        else if (sample.contains("the script")) summary += "；操作=脚本加载";
        else if (sample.contains("the image")) summary += "；操作=图片加载";
        else if (sample.contains("the stylesheet")) summary += "；操作=样式加载";
        else if (sample.contains("the font")) summary += "；操作=字体加载";
        else if (sample.contains("Refused to frame") || sample.contains("Framing")) summary += "；操作=嵌入页面";
        Matcher resource = CSP_RESOURCE.matcher(sample);
        if (resource.find()) summary += "；资源来源=" + resourceOrigin(resource.group(1));
        return summary;
    }

    // Never retain paths, credentials, queries, fragments, inline code or data/blob payloads.
    private static String resourceOrigin(String value) {
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            if ("data".equalsIgnoreCase(scheme)) return "data:[内容已省略]";
            if ("blob".equalsIgnoreCase(scheme)) return "blob:[内容已省略]";
            if (("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)
                    || "ws".equalsIgnoreCase(scheme) || "wss".equalsIgnoreCase(scheme))
                    && uri.getHost() != null) {
                return scheme + "://" + uri.getHost() + (uri.getPort() < 0 ? "" : ":" + uri.getPort());
            }
        } catch (Exception ignored) { }
        return "[未知资源]";
    }

    private WebPageRecovery() { }
}
