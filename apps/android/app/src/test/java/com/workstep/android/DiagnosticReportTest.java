package com.workstep.android;

import static org.junit.Assert.*;
import org.junit.Test;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.io.File;
import java.time.Instant;

public class DiagnosticReportTest {
    @Test
    public void copiesRecentNotificationPageAndRecoveryContextWithoutOldHistory() throws Exception {
        File directory = Files.createTempDirectory("workstep-report").toFile();
        try {
            Files.write(new File(directory, "main-log.txt").toPath(), (
                    "2026-10-07T00:00:00Z 网页主进程 网页加载失败 old-problem\n"
                    + "2026-10-07T01:55:00Z 网页主进程 点击通知；目标=/chat；会话=session-42\n"
                    + "2026-10-07T01:56:00Z 网页主进程 网页渲染失败\njava.lang.Error: blank\n\tat Page.render(Page.java:1)\n")
                    .getBytes(StandardCharsets.UTF_8));
            Files.write(new File(directory, "notification-log.txt").toPath(), (
                    "2026-10-07T01:53:00Z 后台通知进程 WebSocket 连接中断，5秒后重试\n"
                    + "2026-10-07T01:54:00Z 后台通知进程 WebSocket 重连成功\n"
                    + "2026-10-07T01:54:30Z 后台通知进程 系统通知：已发送；目标=/chat?session=session-42\n")
                    .getBytes(StandardCharsets.UTF_8));
            String report = DiagnosticReport.create(directory, Instant.parse("2026-10-07T02:00:00Z").toEpochMilli());
            assertTrue(report.contains("session-42"));
            assertTrue(report.contains("WebSocket 重连成功"));
            assertTrue(report.contains("Page.render(Page.java:1)"));
            assertFalse(report.contains("old-problem"));
        } finally {
            new File(directory, "main-log.txt").delete();
            new File(directory, "notification-log.txt").delete();
            directory.delete();
        }
    }

    @Test
    public void keepsOnlyRecentErrorsAndBoundsTheReportLength() throws Exception {
        File directory = Files.createTempDirectory("workstep-report-limit").toFile();
        try {
            StringBuilder logs = new StringBuilder();
            for (int i = 0; i < 100; i++) {
                logs.append(String.format("2026-10-07T01:59:%02dZ 网页主进程 网页加载失败 problem-%d\n", i % 60, i));
                for (int j = 0; j < 80; j++) logs.append("\tat Example.longMethod(Example.java:123)\n");
            }
            Files.write(new File(directory, "main-log.txt").toPath(), logs.toString().getBytes(StandardCharsets.UTF_8));
            String report = DiagnosticReport.create(directory, Instant.parse("2026-10-07T02:00:00Z").toEpochMilli());
            assertTrue(report.contains("已省略"));
            assertTrue(report.length() <= 14000);
            assertEquals(3, report.split("==== 错误详情 ", -1).length - 1);
        } finally {
            new File(directory, "main-log.txt").delete();
            directory.delete();
        }
    }
}
