package com.workstep.android;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class FileChooserModeTest {
    @Test
    public void detectsImageOnlyAcceptTypes() {
        assertEquals(true, FileChooserMode.isImageOnly(new String[] {"image/*"}));
        assertEquals(true, FileChooserMode.isImageOnly(new String[] {"image/png", "image/jpeg"}));
        assertEquals(false, FileChooserMode.isImageOnly(new String[] {"*/*"}));
        assertEquals(false, FileChooserMode.isImageOnly(new String[] {"image/*", "application/pdf"}));
        assertEquals(false, FileChooserMode.isImageOnly(new String[0]));
    }
}
