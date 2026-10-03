package com.workstep.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class FloatingButtonGestureTest {
    @Test
    public void tapOpensTheWebNavigation() {
        FloatingButtonGesture gesture = new FloatingButtonGesture();
        gesture.down();
        assertFalse(gesture.move(3, 4, 8));
        assertEquals(FloatingButtonGesture.Release.TAP, gesture.release());
    }

    @Test
    public void longPressOpensNativeOptionsWithoutAlsoClicking() {
        FloatingButtonGesture gesture = new FloatingButtonGesture();
        gesture.down();
        assertTrue(gesture.longPress());
        assertFalse(gesture.move(20, 0, 8));
        assertEquals(FloatingButtonGesture.Release.NONE, gesture.release());
    }

    @Test
    public void dragDoesNotOpenEitherMenu() {
        FloatingButtonGesture gesture = new FloatingButtonGesture();
        gesture.down();
        assertTrue(gesture.move(20, 0, 8));
        assertFalse(gesture.longPress());
        assertEquals(FloatingButtonGesture.Release.DRAG, gesture.release());
    }

    @Test
    public void cancelDoesNotOpenEitherMenu() {
        FloatingButtonGesture gesture = new FloatingButtonGesture();
        gesture.down();
        gesture.cancel();
        assertEquals(FloatingButtonGesture.Release.NONE, gesture.release());
    }
}
