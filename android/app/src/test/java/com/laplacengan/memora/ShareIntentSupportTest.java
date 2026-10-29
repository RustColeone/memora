package com.laplacengan.memora;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class ShareIntentSupportTest {

    @Test
    public void launcherAndViewIntentsDoNotTriggerShareNavigation() {
        assertFalse(ShareIntentSupport.isShareAction("android.intent.action.MAIN"));
        assertFalse(ShareIntentSupport.isShareAction("android.intent.action.VIEW"));
        assertFalse(ShareIntentSupport.isShareAction(null));
        assertTrue(ShareIntentSupport.isShareAction("android.intent.action.SEND"));
        assertTrue(ShareIntentSupport.isShareAction("android.intent.action.SEND_MULTIPLE"));
    }

    @Test
    public void googlePhotosSingleStreamAndClipDataAreDeduplicated() {
        String photo = "content://com.google.android.apps.photos.content/photo-1";

        List<String> result = ShareIntentSupport.collectUris(
                photo,
                Collections.emptyList(),
                Collections.singletonList(photo));

        assertEquals(Collections.singletonList(photo), result);
    }

    @Test
    public void samsungClipDataOnlyShareIsAccepted() {
        String image = "content://com.sec.android.app.myfiles/image-1";

        List<String> result = ShareIntentSupport.collectUris(
                null,
                Collections.emptyList(),
                Collections.singletonList(image));

        assertEquals(Collections.singletonList(image), result);
    }

    @Test
    public void gmailMultipleSharePreservesOrderAndDeduplicatesClipData() {
        String first = "content://com.google.android.gm/attachment-1";
        String second = "content://com.google.android.gm/attachment-2";

        List<String> result = ShareIntentSupport.collectUris(
                null,
                Arrays.asList(first, second),
                Arrays.asList(second, first));

        assertEquals(Arrays.asList(first, second), result);
    }

    @Test
    public void providerMimeFallsBackToIntentHintOrSafeFileExtension() {
        assertEquals("image/jpeg", ShareIntentSupport.resolveSupportedMime(
                null, "image/jpeg", "shared_file"));
        assertEquals("application/pdf", ShareIntentSupport.resolveSupportedMime(
                "application/octet-stream", null, "Scan.PDF"));
        assertEquals("image/png", ShareIntentSupport.resolveSupportedMime(
                "image/png", "image/jpeg", "photo.jpg"));
        assertNull(ShareIntentSupport.resolveSupportedMime(
                "text/plain", "text/plain", "note.txt"));
    }

    @Test
    public void pendingShareSurvivesAStoreRecreationAndIsConsumedOnce() {
        MemoryStorage storage = new MemoryStorage();
        PendingShareStore firstProcess = new PendingShareStore(storage);
        firstProcess.save(new PendingShareStore.Payload(
                Arrays.asList(
                        "content://com.google.android.apps.photos.content/photo-1",
                        "content://com.google.android.gm/attachment-2"),
                "shared text",
                "image/*"));

        PendingShareStore recreatedProcess = new PendingShareStore(storage);
        PendingShareStore.Payload restored = recreatedProcess.take();

        assertEquals(2, restored.uriStrings.size());
        assertEquals("shared text", restored.text);
        assertEquals("image/*", restored.mimeHint);
        assertTrue(recreatedProcess.take().isEmpty());
    }

    @Test
    public void malformedPersistedShareFailsClosedAndIsCleared() {
        MemoryStorage storage = new MemoryStorage();
        storage.value = "not-a-valid-pending-share";

        PendingShareStore.Payload result = new PendingShareStore(storage).take();

        assertTrue(result.isEmpty());
        assertNull(storage.value);
    }

    @Test
    public void peekKeepsARecoveredShareRetryableUntilExplicitAcknowledgement() {
        MemoryStorage storage = new MemoryStorage();
        PendingShareStore store = new PendingShareStore(storage);
        store.save(new PendingShareStore.Payload(
                Collections.singletonList("content://provider/transient-file"),
                "retry me",
                "image/png"));

        PendingShareStore.Payload firstAttempt = store.peek();
        PendingShareStore.Payload recreatedAttempt = new PendingShareStore(storage).peek();

        assertEquals(firstAttempt.uriStrings, recreatedAttempt.uriStrings);
        assertEquals("retry me", recreatedAttempt.text);
        assertTrue(store.ack(firstAttempt));
        assertTrue(store.peek().isEmpty());
    }

    @Test
    public void acknowledgingAnOlderShareCannotEraseANewerIncomingShare() {
        MemoryStorage storage = new MemoryStorage();
        PendingShareStore store = new PendingShareStore(storage);
        store.save(new PendingShareStore.Payload(
                Collections.singletonList("content://provider/old"), "old", "image/png"));
        PendingShareStore.Payload old = store.peek();

        store.save(new PendingShareStore.Payload(
                Collections.singletonList("content://provider/new"), "new", "image/jpeg"));

        assertTrue(!store.ack(old));
        assertEquals("new", store.peek().text);
    }

    private static final class MemoryStorage implements PendingShareStore.Storage {
        String value;

        @Override
        public String read() {
            return value;
        }

        @Override
        public void write(String encoded) {
            value = encoded;
        }

        @Override
        public void clear() {
            value = null;
        }
    }
}
