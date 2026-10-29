package com.laplacengan.memora;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Pure, provider-agnostic normalization used by the Android share boundary. */
final class ShareIntentSupport {
    private ShareIntentSupport() {}

    static boolean isShareAction(String action) {
        return "android.intent.action.SEND".equals(action)
                || "android.intent.action.SEND_MULTIPLE".equals(action);
    }

    static <T> List<T> collectUris(T single, List<T> multiple, List<T> clipItems) {
        Set<T> ordered = new LinkedHashSet<>();
        if (single != null) ordered.add(single);
        if (multiple != null) {
            for (T item : multiple) if (item != null) ordered.add(item);
        }
        if (clipItems != null) {
            for (T item : clipItems) if (item != null) ordered.add(item);
        }
        return new ArrayList<>(ordered);
    }

    static String resolveSupportedMime(String providerMime, String intentMime, String displayName) {
        String provider = normalizeMime(providerMime);
        if (isConcreteSupportedMime(provider)) return provider;

        String hint = normalizeMime(intentMime);
        if (isConcreteSupportedMime(hint)) return hint;

        boolean providerUnknown = provider.isEmpty() || "application/octet-stream".equals(provider);
        boolean hintUnknown = hint.isEmpty() || "application/octet-stream".equals(hint)
                || "image/*".equals(hint);
        if (!providerUnknown || !hintUnknown) return null;

        String name = displayName == null ? "" : displayName.toLowerCase(Locale.ROOT);
        if (name.endsWith(".pdf")) return "application/pdf";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".gif")) return "image/gif";
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".avif")) return "image/avif";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        return null;
    }

    private static String normalizeMime(String mime) {
        if (mime == null) return "";
        int parameters = mime.indexOf(';');
        String value = parameters >= 0 ? mime.substring(0, parameters) : mime;
        return value.trim().toLowerCase(Locale.ROOT);
    }

    private static boolean isConcreteSupportedMime(String mime) {
        return "application/pdf".equals(mime)
                || (mime.startsWith("image/") && !"image/*".equals(mime));
    }
}
