package com.workstep.android;

import org.junit.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

public class WakeGreetingAudioTest {
    @Test public void completeGreetingIsPreservedBetweenSilentFrames() {
        byte[] pcm = {1, 2, 3, 4};
        byte[] wav = SystemSpeech.wave(pcm, 24000);
        ByteBuffer header = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        int opening = 15360;
        int ending = 4800;
        assertEquals(0x46464952, header.getInt(0));
        assertEquals(wav.length - 8, header.getInt(4));
        assertEquals(24000, header.getInt(24));
        assertEquals(opening + pcm.length + ending, header.getInt(40));
        assertArrayEquals(new byte[opening], Arrays.copyOfRange(wav, 44, 44 + opening));
        assertArrayEquals(pcm, Arrays.copyOfRange(wav, 44 + opening, 44 + opening + pcm.length));
        assertArrayEquals(new byte[ending], Arrays.copyOfRange(wav, wav.length - ending, wav.length));
    }
}
