package com.workstep.android;

import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;

public class RuntimeDiagnosticsTest {
    @Test
    public void readsRecordingScriptWithoutAndroid13StreamMethods() throws Exception {
        String script = "window.title = '运行诊断';\n".repeat(600);
        ByteArrayInputStream input = new ByteArrayInputStream(script.getBytes(StandardCharsets.UTF_8)) {
            @Override public synchronized int read(byte[] buffer, int offset, int length) {
                return super.read(buffer, offset, Math.min(length, 5));
            }

            @Override public byte[] readAllBytes() {
                throw new NoSuchMethodError("Unavailable before Android API 33");
            }
        };

        assertEquals(script, RuntimeDiagnostics.readRecordingScript(input));
    }
}
