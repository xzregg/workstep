package com.workstep.android;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Produces a bounded report with recent context and only a few error stacks. */
final class DiagnosticReport {
    private static final class Entry {
        long time;
        String header;
        String text;
    }

    static String create(File directory, long now) {
        List<Entry> recent = new ArrayList<>();
        StringBuilder report = new StringBuilder("生成时间：").append(Instant.ofEpochMilli(now))
                .append("\n范围：最近30分钟，最多30条诊断事件和3条错误详情\n");
        for (String name : new String[]{"main-log.txt", "notification-log.txt"}) {
            File file = new File(directory, name);
            if (!file.exists()) continue;
            try {
                String content = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
                for (String text : content.split("(?m)(?=^\\d{4}-\\d{2}-\\d{2}T)")) {
                    String header = text.split("\n", 2)[0];
                    try {
                        long time = Instant.parse(header.split(" ", 2)[0]).toEpochMilli();
                        if (time < now - 30 * 60000L || time > now + 60000L) continue;
                        if (!header.matches(".*(通知|WebSocket|网页|后台|前台|服务|监听|补查|匹配结果|失败|异常|错误|崩溃|超时).*")
                                && !text.contains("Exception") && !text.contains("Error")) continue;
                        Entry entry = new Entry();
                        entry.time = time;
                        entry.header = header;
                        entry.text = text;
                        recent.add(entry);
                    } catch (RuntimeException ignored) { }
                }
            } catch (Exception error) {
                report.append("读取日志失败：").append(name).append('\n');
            }
        }
        recent.sort(Comparator.comparingLong(entry -> entry.time));
        report.append("\n==== 最近操作与连接状态 ====\n");
        if (recent.isEmpty()) report.append("最近30分钟暂无记录，请复现问题后复制。\n");
        for (Entry entry : recent.subList(Math.max(0, recent.size() - 30), recent.size())) {
            report.append(shorten(entry.header, 240)).append('\n');
        }
        if (recent.size() > 30) report.append("已省略较早的诊断事件。\n");
        List<Entry> errors = new ArrayList<>();
        for (Entry entry : recent) {
            if (entry.header.matches(".*(失败|异常|错误|崩溃|超时|未显示|无法).*")
                    || entry.text.contains("Exception") || entry.text.contains("Error")) errors.add(entry);
        }
        if (errors.isEmpty()) report.append("\n最近30分钟未记录错误。\n");
        int number = 0;
        for (Entry entry : errors.subList(Math.max(0, errors.size() - 3), errors.size())) {
            report.append("\n==== 错误详情 ").append(++number).append(" ====\n")
                    .append(shorten(entry.text, 1600)).append('\n');
        }
        if (errors.size() > 3) report.append("已省略较早的错误详情。\n");
        File crash = new File(directory, "last-crash.txt");
        if (crash.exists()) {
            try {
                report.append("\n==== 上次未处理崩溃 ====\n").append(shorten(
                        new String(Files.readAllBytes(crash.toPath()), StandardCharsets.UTF_8), 1600));
            } catch (Exception ignored) { }
        }
        return shorten(report.toString(), 14000);
    }

    private static String shorten(String text, int limit) {
        if (text.length() <= limit) return text;
        int tail = limit / 4;
        return text.substring(0, limit - tail - 30) + "\n[已省略中间内容]\n" + text.substring(text.length() - tail);
    }
}
