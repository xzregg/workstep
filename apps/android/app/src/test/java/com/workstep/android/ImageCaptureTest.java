package com.workstep.android;

import static org.junit.Assert.*;
import java.io.File;
import java.nio.file.Files;
import org.junit.Test;

public class ImageCaptureTest {
    @Test public void onlyConfirmedNonEmptyCameraOutputBecomesAnAttachment() throws Exception {
        File photo = File.createTempFile("workstep-photo", ".jpg");
        try {
            assertFalse(ImageCapture.hasImage(true, null));
            assertFalse(ImageCapture.hasImage(true, photo));
            Files.write(photo.toPath(), new byte[]{1, 2, 3});
            assertTrue(ImageCapture.hasImage(true, photo));
            assertFalse(ImageCapture.hasImage(false, photo));
            assertTrue(photo.delete());
            assertFalse(ImageCapture.hasImage(true, photo));
        } finally { photo.delete(); }
    }
}
