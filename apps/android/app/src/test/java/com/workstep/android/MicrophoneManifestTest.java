package com.workstep.android;

import static org.junit.Assert.*;
import java.io.File;
import java.util.HashMap;
import java.util.Map;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.Test;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

public class MicrophoneManifestTest {
    @Test
    public void webViewAudioCaptureHasBothRequiredPermissionsWithoutSdkLimits() throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        NodeList entries = factory.newDocumentBuilder()
                .parse(new File("src/main/AndroidManifest.xml"))
                .getElementsByTagName("uses-permission");
        String android = "http://schemas.android.com/apk/res/android";
        Map<String, Element> permissions = new HashMap<>();
        for (int i = 0; i < entries.getLength(); i++) {
            Element entry = (Element) entries.item(i);
            permissions.put(entry.getAttributeNS(android, "name"), entry);
        }
        for (String name : new String[]{"android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"}) {
            assertTrue("WebView capture requires " + name, permissions.containsKey(name));
            assertFalse("Capture must work on current Android versions", permissions.get(name).hasAttributeNS(android, "maxSdkVersion"));
        }
    }
}
