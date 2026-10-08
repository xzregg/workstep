package com.workstep.android;

import org.junit.Test;
import static org.junit.Assert.*;

public class NotificationContentTest {
    @Test public void identifiesSessionTaskAndStepWithoutChangingTheOutcome() {
        assertEquals("安卓排查 · 回复完成", NotificationContent.title("安卓排查", false, true));
        assertEquals("任务「修复上传」的回复失败", NotificationContent.body("修复上传", true, "", false));
        assertEquals("任务「修复上传」：步骤 review 已通过", NotificationContent.body("修复上传", true, "review", true));
    }
    @Test public void truncatesLongNamesAndKeepsTheResultVisible() {
        String longName = "测".repeat(1000);
        String shortName = "测".repeat(19) + "…";
        assertEquals(shortName + " · 回复完成", NotificationContent.title(longName, false, true));
        assertEquals("会话「" + shortName + "」的回复失败", NotificationContent.body(longName, false, "", false));
        assertEquals(shortName, NotificationContent.name(longName, "s", ""));
        assertEquals("😀".repeat(19) + "… · 步骤失败", NotificationContent.title("😀".repeat(21), true, false));
        assertEquals("单行 名称 · 回复完成", NotificationContent.title("  单行\n名称  ", false, true));
    }
    @Test public void bridgeUsesProvidedNameOrRegisteredWatchName() {
        assertEquals("当前标题", NotificationContent.bridgeName("当前标题", "旧标题", "s", ""));
        assertEquals("监听标题", NotificationContent.bridgeName("null", "监听标题", "s", ""));
        assertEquals("会话 s", NotificationContent.bridgeName("", "", "s", ""));
    }
    @Test public void missingNameFallsBackToScopeIdAndRejectsJsonNull() {
        assertEquals("会话 session-42", NotificationContent.name("null", "session-42", ""));
        assertEquals("任务 task-42", NotificationContent.name("  ", "", "task-42"));
    }
}
