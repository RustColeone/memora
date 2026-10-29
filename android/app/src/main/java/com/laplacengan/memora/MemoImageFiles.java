package com.laplacengan.memora;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;

import androidx.exifinterface.media.ExifInterface;

import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate;

import java.io.File;
import java.io.IOException;
import java.util.regex.Pattern;

/**
 * Shared, bounded access to images Memora already stores in its private
 * folder (files/MemoSystem/uploads/…), for the native image tools. JavaScript
 * passes only the stored path ("uploads/2026-10-17/0912_x_1_receipt.jpg");
 * anything outside that folder, or not shaped like a stored image, is refused.
 * Ported from ImageDB's ImageTextPlugin helpers.
 */
final class MemoImageFiles {

    static final long MAX_INPUT_BYTES = 96L * 1024L * 1024L;
    static final long MAX_IMAGE_PIXELS = 100_000_000L;

    static final String CODE_INVALID_PATH = "TOOL_INVALID_PATH";
    static final String CODE_FILE_NOT_FOUND = "TOOL_FILE_NOT_FOUND";
    static final String CODE_FILE_TOO_LARGE = "TOOL_FILE_TOO_LARGE";
    static final String CODE_IMAGE_UNREADABLE = "TOOL_IMAGE_UNREADABLE";
    static final String CODE_IMAGE_TOO_LARGE = "TOOL_IMAGE_TOO_LARGE";

    private static final String UPLOAD_ROOT = "MemoSystem/uploads";
    // uploads/<name> or uploads/<day folder>/<name>; names as memo-core writes them.
    private static final Pattern STORED_IMAGE = Pattern.compile(
            "^uploads/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}/)?[A-Za-z0-9][A-Za-z0-9._-]{0,239}\\.(?:jpe?g|png|webp|bmp|heic|heif)$",
            Pattern.CASE_INSENSITIVE);

    private MemoImageFiles() {}

    static final class InputException extends Exception {
        final String code;

        InputException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    static File resolveStoredImage(File filesDir, String path) throws InputException {
        if (filesDir == null || path == null || path.contains("..") || !STORED_IMAGE.matcher(path).matches()) {
            throw new InputException(CODE_INVALID_PATH, "Only an image stored by Memora is accepted");
        }
        try {
            File root = new File(filesDir, UPLOAD_ROOT).getCanonicalFile();
            File candidate = new File(new File(filesDir, "MemoSystem"), path).getCanonicalFile();
            if (!candidate.getPath().startsWith(root.getPath() + File.separator)) {
                throw new InputException(CODE_INVALID_PATH, "The image must be in Memora's private uploads folder");
            }
            return candidate;
        } catch (IOException error) {
            throw new InputException(CODE_INVALID_PATH, "The stored image path is invalid");
        }
    }

    static void validateReadableImage(File file) throws InputException {
        if (!file.isFile() || !file.canRead()) {
            throw new InputException(CODE_FILE_NOT_FOUND, "The stored image is unavailable");
        }
        long size = file.length();
        if (size <= 0) throw new InputException(CODE_IMAGE_UNREADABLE, "The stored image is empty");
        if (size > MAX_INPUT_BYTES) {
            throw new InputException(CODE_FILE_TOO_LARGE, "The stored image exceeds the tool safety limit");
        }
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new InputException(CODE_IMAGE_UNREADABLE, "The stored image format could not be decoded");
        }
        if ((long) bounds.outWidth * (long) bounds.outHeight > MAX_IMAGE_PIXELS) {
            throw new InputException(CODE_IMAGE_TOO_LARGE, "The stored image dimensions exceed the tool safety limit");
        }
    }

    /** A bounded, EXIF-oriented working bitmap: a phone camera's full raster is never held. */
    static Bitmap decodeSampledBitmap(File file, int maxDimension, long maxPixels) throws InputException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new InputException(CODE_IMAGE_UNREADABLE, "The stored image format could not be decoded");
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = calculateInSampleSize(bounds.outWidth, bounds.outHeight, maxDimension, maxPixels);
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        final Bitmap decoded;
        try {
            decoded = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        } catch (OutOfMemoryError error) {
            throw new InputException(CODE_IMAGE_TOO_LARGE, "The stored image is too large to decode safely");
        }
        if (decoded == null) throw new InputException(CODE_IMAGE_UNREADABLE, "The stored image could not be decoded");

        Matrix transform = exifTransform(file);
        if (transform == null || transform.isIdentity()) return decoded;
        try {
            Bitmap oriented = Bitmap.createBitmap(decoded, 0, 0, decoded.getWidth(), decoded.getHeight(), transform, true);
            if (oriented != decoded) decoded.recycle();
            return oriented;
        } catch (RuntimeException | OutOfMemoryError error) {
            decoded.recycle();
            throw new InputException(CODE_IMAGE_UNREADABLE, "The stored image orientation could not be applied");
        }
    }

    static int calculateInSampleSize(int width, int height, int maxDimension, long maxPixels) {
        int sample = 1;
        while ((Math.max(width, height) / sample) > maxDimension
                || ((long) Math.max(1, width / sample) * Math.max(1, height / sample)) > maxPixels) {
            if (sample >= (1 << 29)) return sample;
            sample *= 2;
        }
        return sample;
    }

    static Matrix exifTransform(File file) {
        final int orientation;
        try {
            orientation = new ExifInterface(file.getAbsolutePath()).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (IOException | RuntimeException ignored) {
            return null;
        }
        Matrix matrix = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: matrix.setScale(-1f, 1f); break;
            case ExifInterface.ORIENTATION_ROTATE_180: matrix.setRotate(180f); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: matrix.setScale(1f, -1f); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: matrix.setRotate(90f); matrix.postScale(-1f, 1f); break;
            case ExifInterface.ORIENTATION_ROTATE_90: matrix.setRotate(90f); break;
            case ExifInterface.ORIENTATION_TRANSVERSE: matrix.setRotate(-90f); matrix.postScale(-1f, 1f); break;
            case ExifInterface.ORIENTATION_ROTATE_270: matrix.setRotate(-90f); break;
            default: return null;
        }
        return matrix;
    }

    static String truncate(String value, int maxChars) {
        if (value == null) return "";
        return value.length() <= maxChars ? value : value.substring(0, maxChars);
    }

    static String installStateName(int state) {
        switch (state) {
            case ModuleInstallStatusUpdate.InstallState.STATE_PENDING: return "pending";
            case ModuleInstallStatusUpdate.InstallState.STATE_DOWNLOADING: return "downloading";
            case ModuleInstallStatusUpdate.InstallState.STATE_INSTALLING: return "installing";
            case ModuleInstallStatusUpdate.InstallState.STATE_DOWNLOAD_PAUSED: return "paused";
            case ModuleInstallStatusUpdate.InstallState.STATE_COMPLETED: return "completed";
            case ModuleInstallStatusUpdate.InstallState.STATE_CANCELED: return "cancelled";
            case ModuleInstallStatusUpdate.InstallState.STATE_FAILED: return "failed";
            default: return "unknown";
        }
    }
}
