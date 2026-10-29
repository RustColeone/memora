package com.laplacengan.memora;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * One-shot, process-independent inbox for a share intent. The storage adapter is
 * deliberately tiny so serialization and process-recreation behavior remain
 * covered by ordinary JVM tests rather than requiring a connected device.
 */
final class PendingShareStore {
    private static final String VERSION = "memora-share-v1";
    private static final int MAX_DECODED_URIS = 64;

    interface Storage {
        String read();
        void write(String encoded);
        void clear();
    }

    static final class Payload {
        final List<String> uriStrings;
        final String text;
        final String mimeHint;
        private final String encodedRecord;

        Payload(List<String> uriStrings, String text, String mimeHint) {
            this(uriStrings, text, mimeHint, null);
        }

        private Payload(List<String> uriStrings, String text, String mimeHint, String encodedRecord) {
            this.uriStrings = Collections.unmodifiableList(new ArrayList<>(
                    uriStrings == null ? Collections.emptyList() : uriStrings));
            this.text = text == null ? "" : text;
            this.mimeHint = mimeHint == null ? "" : mimeHint;
            this.encodedRecord = encodedRecord;
        }

        boolean isEmpty() {
            return uriStrings.isEmpty() && text.trim().isEmpty();
        }
    }

    private final Storage storage;

    PendingShareStore(Storage storage) {
        this.storage = storage;
    }

    void save(Payload payload) {
        synchronized (PendingShareStore.class) {
            if (payload == null || payload.isEmpty()) {
                storage.clear();
                return;
            }
            StringBuilder encoded = new StringBuilder(VERSION).append('\n')
                    .append(encode(payload.mimeHint)).append('\n')
                    .append(encode(payload.text)).append('\n')
                    .append(payload.uriStrings.size());
            for (String uri : payload.uriStrings) encoded.append('\n').append(encode(uri));
            storage.write(encoded.toString());
        }
    }

    Payload peek() {
        synchronized (PendingShareStore.class) {
            String encoded = storage.read();
            if (encoded == null || encoded.isEmpty()) return emptyPayload();
            try {
                String[] lines = encoded.split("\\n", -1);
                if (lines.length < 4 || !VERSION.equals(lines[0])) {
                    storage.clear();
                    return emptyPayload();
                }
                int count = Integer.parseInt(lines[3]);
                if (count < 0 || count > MAX_DECODED_URIS || lines.length != 4 + count) {
                    storage.clear();
                    return emptyPayload();
                }
                List<String> uris = new ArrayList<>(count);
                for (int index = 0; index < count; index++) {
                    String uri = decode(lines[4 + index]);
                    if (!uri.isEmpty()) uris.add(uri);
                }
                return new Payload(uris, decode(lines[2]), decode(lines[1]), encoded);
            } catch (Exception ignored) {
                storage.clear();
                return emptyPayload();
            }
        }
    }

    boolean ack(Payload payload) {
        synchronized (PendingShareStore.class) {
            if (payload == null || payload.encodedRecord == null) return false;
            String current = storage.read();
            if (!payload.encodedRecord.equals(current)) return false;
            storage.clear();
            return true;
        }
    }

    Payload take() {
        Payload payload = peek();
        ack(payload);
        return payload;
    }

    private static Payload emptyPayload() {
        return new Payload(Collections.emptyList(), "", "");
    }

    private static String encode(String value) {
        byte[] bytes = String.valueOf(value == null ? "" : value).getBytes(StandardCharsets.UTF_8);
        char[] hex = new char[bytes.length * 2];
        final char[] alphabet = "0123456789abcdef".toCharArray();
        for (int index = 0; index < bytes.length; index++) {
            int valueByte = bytes[index] & 0xff;
            hex[index * 2] = alphabet[valueByte >>> 4];
            hex[index * 2 + 1] = alphabet[valueByte & 0x0f];
        }
        return new String(hex);
    }

    private static String decode(String value) {
        if ((value.length() & 1) != 0) throw new IllegalArgumentException("Invalid hex payload");
        byte[] bytes = new byte[value.length() / 2];
        for (int index = 0; index < bytes.length; index++) {
            int high = Character.digit(value.charAt(index * 2), 16);
            int low = Character.digit(value.charAt(index * 2 + 1), 16);
            if (high < 0 || low < 0) throw new IllegalArgumentException("Invalid hex payload");
            bytes[index] = (byte) ((high << 4) | low);
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
