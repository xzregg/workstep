package com.workstep.android;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import org.junit.Test;

public class SavedServerAddressesTest {
    @Test
    public void migratesCurrentAddressAndNormalizesSavedEntries() {
        assertEquals(Arrays.asList("https://one.example.com", "http://two.example.com:8765"),
                SavedServerAddresses.load("https://one.example.com/\ninvalid\nhttp://two.example.com:8765\nhttps://one.example.com",
                        "https://one.example.com"));
        assertEquals(Arrays.asList("https://one.example.com"),
                SavedServerAddresses.load("", "https://one.example.com/"));
    }

    @Test
    public void addsOnlyNewAddressAndPersistsList() {
        var saved = SavedServerAddresses.load("https://one.example.com", "https://one.example.com");
        assertEquals(Arrays.asList("https://one.example.com", "https://two.example.com"),
                SavedServerAddresses.add(saved, "https://two.example.com/"));
        assertEquals(saved, SavedServerAddresses.add(saved, "https://one.example.com/"));
        assertEquals(Arrays.asList("https://one.example.com", "https://two.example.com"),
                SavedServerAddresses.load(SavedServerAddresses.store(
                        SavedServerAddresses.add(saved, "https://two.example.com")), ""));
    }

    @Test
    public void removesSelectedAddressIncludingActiveAfterActivePreferenceIsCleared() {
        var saved = SavedServerAddresses.load("https://one.example.com\nhttps://two.example.com",
                "https://one.example.com");
        var remaining = SavedServerAddresses.remove(saved, "https://one.example.com/");
        assertEquals(Arrays.asList("https://two.example.com"), remaining);
        assertEquals(remaining, SavedServerAddresses.load(SavedServerAddresses.store(remaining), ""));
        assertEquals(remaining, SavedServerAddresses.remove(remaining, "https://absent.example.com"));
    }
}
