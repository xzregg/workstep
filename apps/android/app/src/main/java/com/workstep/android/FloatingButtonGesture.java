package com.workstep.android;

final class FloatingButtonGesture {
    enum Release { TAP, DRAG, NONE }

    private boolean active;
    private boolean dragging;
    private boolean longPressed;

    void down() {
        active = true;
        dragging = false;
        longPressed = false;
    }

    boolean move(float dx, float dy, int touchSlop) {
        if (!active || longPressed) return false;
        if (!dragging && Math.hypot(dx, dy) > touchSlop) dragging = true;
        return dragging;
    }

    boolean longPress() {
        if (!active || dragging || longPressed) return false;
        longPressed = true;
        return true;
    }

    Release release() {
        Release result = !active || longPressed ? Release.NONE : dragging ? Release.DRAG : Release.TAP;
        cancel();
        return result;
    }

    void cancel() {
        active = false;
        dragging = false;
        longPressed = false;
    }
}
