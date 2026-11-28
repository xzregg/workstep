package com.workstep.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores P2P metadata in private preferences and pair keys encrypted by Android Keystore. */
final class P2pStore {
    private static final String ALIAS = "workstep-p2p-pair-key-v1";
    private static final String ENTRIES = "entries";
    private final SharedPreferences preferences;

    P2pStore(Context context) {
        preferences = context.getSharedPreferences("p2p_connections", Context.MODE_PRIVATE);
    }

    List<P2pConnection> load() {
        List<P2pConnection> result = new ArrayList<>();
        try {
            JSONArray records = new JSONArray(preferences.getString(ENTRIES, "[]"));
            for (int i = 0; i < records.length(); i++) {
                JSONObject record = records.optJSONObject(i);
                if (record == null) continue;
                try {
                    P2pConnection item = P2pConnection.parse(record.getString("url")
                            + "#pair_key=" + decrypt(record.getString("secret")));
                    if (result.stream().noneMatch(saved -> saved.entryUrl().equals(item.entryUrl())))
                        result.add(item);
                } catch (Exception ignored) {
                    // A removed device key or malformed legacy record cannot open a connection.
                }
            }
        } catch (Exception ignored) {
            // Keep the address screen usable when local storage is damaged.
        }
        return result;
    }

    void save(List<P2pConnection> items) {
        try {
            JSONArray records = new JSONArray();
            for (P2pConnection item : items) {
                JSONObject record = new JSONObject();
                record.put("url", item.entryUrl());
                record.put("secret", encrypt(item.key()));
                records.put(record);
            }
            if (!preferences.edit().putString(ENTRIES, records.toString()).commit())
                throw new IllegalStateException("无法保存 P2P 设备");
        } catch (Exception error) {
            throw new IllegalStateException("无法安全保存 P2P 设备", error);
        }
    }

    private SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey existing = (SecretKey) store.getKey(ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    private String encrypt(String key) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(key.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        byte[] output = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, output, 0, iv.length);
        System.arraycopy(encrypted, 0, output, iv.length, encrypted.length);
        return Base64.encodeToString(output, Base64.NO_WRAP);
    }

    private String decrypt(String value) throws Exception {
        byte[] bytes = Base64.decode(value, Base64.NO_WRAP);
        if (bytes.length <= 28) throw new IllegalArgumentException("密钥记录无效");
        byte[] iv = java.util.Arrays.copyOfRange(bytes, 0, 12);
        byte[] data = java.util.Arrays.copyOfRange(bytes, 12, bytes.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(data), java.nio.charset.StandardCharsets.UTF_8);
    }
}
