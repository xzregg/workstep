package com.workstep.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;

public class CrashReportsTest {
    @Test
    public void clearsOnlyWorkStepLogs() throws Exception {
        File directory = Files.createTempDirectory("workstep-logs").toFile();
        File main = new File(directory, "main-log.txt");
        File notification = new File(directory, "notification-log.txt");
        File crash = new File(directory, "last-crash.txt");
        File unrelated = new File(directory, "settings.txt");
        try {
            assertTrue(main.createNewFile());
            assertTrue(notification.createNewFile());
            assertTrue(crash.createNewFile());
            assertTrue(unrelated.createNewFile());

            assertTrue(CrashReports.clearFiles(directory));

            assertFalse(main.exists());
            assertFalse(notification.exists());
            assertFalse(crash.exists());
            assertTrue(unrelated.exists());
            assertTrue(CrashReports.clearFiles(directory));
        } finally {
            main.delete();
            notification.delete();
            crash.delete();
            unrelated.delete();
            directory.delete();
        }
    }

    @Test
    public void copiesOnlyErrorsWithTheirStackTraces() throws Exception {
        File directory = Files.createTempDirectory("workstep-errors").toFile();
        File main = new File(directory, "main-log.txt");
        File notification = new File(directory, "notification-log.txt");
        File crash = new File(directory, "last-crash.txt");
        try {
            Files.write(main.toPath(), ("2026-10-05T01:00:00Z 网页主进程 应用启动\n"
                    + "2026-10-05T01:01:00Z 网页主进程 启动监听失败\n"
                    + "java.lang.IllegalStateException: denied\n\tat Example.run(Example.java:1)\n"
                    + "2026-10-05T01:02:00Z 网页主进程 返回前台\n"
                    + "2026-10-05T01:02:01Z 网页主进程 点击通知；目标=/tasks；任务=task-42\n").getBytes(StandardCharsets.UTF_8));
            Files.write(notification.toPath(), ("2026-10-05T01:03:00Z 后台通知进程 WebSocket 已连接\n"
                    + "2026-10-05T01:03:01Z 后台通知进程 WebSocket 连接中断，5秒后重试\n"
                    + "2026-10-05T01:03:02Z 后台通知进程 WebSocket 重连成功\n"
                    + "2026-10-05T01:03:03Z 后台通知进程 WebSocket 重连失败；将继续重试\n"
                    + "2026-10-05T01:04:00Z 后台通知进程 通知未显示：权限不足\n"
                    + "2026-10-05T01:05:00Z 后台通知进程 系统通知：已发送；目标=/tasks?task=task-42\n")
                    .getBytes(StandardCharsets.UTF_8));
            Files.write(crash.toPath(), "后台通知进程\njava.lang.Error: crash\n".getBytes(StandardCharsets.UTF_8));

            String errors = CrashReports.errorLogs(directory);
            assertTrue(errors.contains("启动监听失败\njava.lang.IllegalStateException: denied\n\tat Example.run"));
            assertTrue(errors.contains("通知未显示：权限不足"));
            assertTrue(errors.contains("java.lang.Error: crash"));
            assertTrue(errors.contains("点击通知；目标=/tasks；任务=task-42"));
            assertTrue(errors.contains("系统通知：已发送；目标=/tasks?task=task-42"));
            assertFalse(errors.contains("应用启动"));
            assertFalse(errors.contains("WebSocket 已连接"));
            assertFalse(errors.contains("WebSocket 连接中断"));
            assertFalse(errors.contains("WebSocket 重连成功"));
            assertTrue(errors.contains("WebSocket 重连失败"));
            assertFalse(errors.contains("返回前台"));
        } finally {
            main.delete();
            notification.delete();
            crash.delete();
            directory.delete();
        }
    }

    @Test
    public void reportsWhenThereAreNoErrors() throws Exception {
        File directory = Files.createTempDirectory("workstep-no-errors").toFile();
        try {
            assertEquals("暂无错误日志", CrashReports.errorLogs(directory));
        } finally {
            directory.delete();
        }
    }
}
