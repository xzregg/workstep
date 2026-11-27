package com.workstep.android;

import static org.junit.Assert.*;
import java.io.File;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.Test;
import org.w3c.dom.Element;

public class LauncherIconTest {
    private static final String ANDROID = "http://schemas.android.com/apk/res/android";

    @Test
    public void launcherAndRoundIconUseTheSameAdaptiveResource() throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        Element application = (Element) factory.newDocumentBuilder()
                .parse(new File("src/main/AndroidManifest.xml"))
                .getElementsByTagName("application").item(0);
        assertEquals("@drawable/app_icon", application.getAttributeNS(ANDROID, "icon"));
        assertEquals("@drawable/app_icon", application.getAttributeNS(ANDROID, "roundIcon"));
        Element icon = factory.newDocumentBuilder()
                .parse(new File("src/main/res/drawable-anydpi-v26/app_icon.xml"))
                .getDocumentElement();
        assertEquals("adaptive-icon", icon.getTagName());
        assertEquals("@android:color/white", ((Element) icon.getElementsByTagName("background")
                .item(0)).getAttributeNS(ANDROID, "drawable"));
        assertEquals("@drawable/app_icon_foreground", ((Element) icon.getElementsByTagName("foreground")
                .item(0)).getAttributeNS(ANDROID, "drawable"));
    }

}
