package com.laplacengan.memora;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import org.json.*;
import java.text.SimpleDateFormat;
import java.util.Locale;

/**
 * Persisted local alarms; no WebView or network is needed at delivery time.
 * A repeating event arrives with the dates it comes round ("dates") and holds
 * a single alarm, moved on to the next date each time one is delivered.
 */
public class PlannerReminderReceiver extends BroadcastReceiver {
    static final String CHANNEL = "planner-reminders";
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("planner-reminders", 0); }
    static JSONArray events(Context c) {
        try { return new JSONArray(prefs(c).getString("events", "[]")); }
        catch (JSONException e) { return new JSONArray(); }
    }
    static PendingIntent alarm(Context c, String id) {
        Intent i = new Intent(c, PlannerReminderReceiver.class).setAction("memora.PLANNER_REMINDER")
            .setData(Uri.parse("memora-reminder:" + Uri.encode(id))).putExtra("id", id);
        return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    /** The dates an event comes round, soonest first; a one-off event has one. */
    static String[] dates(JSONObject event) {
        JSONArray list = event.optJSONArray("dates");
        if (list == null || list.length() == 0) return new String[] { event.optString("date") };
        String[] out = new String[list.length()];
        for (int i = 0; i < out.length; i++) out[i] = list.optString(i);
        return out;
    }
    static long due(JSONObject event, String date) {
        try {
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US);
            format.setLenient(false);
            return format.parse(date + " " + event.optString("start", "09:00")).getTime()
                - event.getInt("remindBefore") * 60000L;
        } catch (Exception e) { return -1; }
    }
    static String signature(JSONObject event, String date) {
        return date + "|" + event.optString("start") + "|" + event.optInt("remindBefore");
    }
    static long nextDelivery(long due, long now) {
        // Resume/time changes must not erase an alarm Android has deferred.
        return due < 0 || now - due > 86400000L ? -1 : Math.max(due, now);
    }
    static String dateOf(String signature) {
        return signature.contains("|") ? signature.substring(0, signature.indexOf('|')) : "";
    }
    /**
     * The date to deliver next, or null: of the dates not yet delivered and
     * not too old, the latest one already due (a deferred alarm shows once,
     * not once per date it missed), else the soonest still to come.
     */
    static String pending(Context c, JSONObject event, long now) {
        String deliveredDate = dateOf(prefs(c).getString("delivered:" + event.optString("id"), ""));
        String passed = null;
        for (String date : dates(event)) {
            if (!deliveredDate.isEmpty() && date.compareTo(deliveredDate) <= 0) continue;
            long due = due(event, date);
            if (nextDelivery(due, now) < 0) continue;
            if (due > now) return passed != null ? passed : date;
            passed = date;
        }
        return passed;
    }
    /** Whether a delivered notification still describes this event. */
    static boolean retained(JSONObject candidate, String delivered) {
        String deliveredDate = dateOf(delivered);
        String[] list = dates(candidate);
        // Gone by, not changed: a repeating event's window has moved past it.
        if (!deliveredDate.isEmpty() && deliveredDate.compareTo(list[0]) < 0 && candidate.has("dates")) return true;
        for (String date : list) if (signature(candidate, date).equals(delivered)) return true;
        return false;
    }
    static synchronized void replace(Context c, JSONArray next) throws JSONException {
        AlarmManager manager = (AlarmManager)c.getSystemService(Context.ALARM_SERVICE);
        JSONArray previous = events(c);
        // Persist first: a failed checkpoint must leave the previous alarms alive.
        if (!prefs(c).edit().putString("events", next.toString()).commit()) throw new IllegalStateException("Reminder storage failed");
        // Up to 0.0.16 each date of a repeating event was its own "<id>@<date>";
        // keep what those showed so the update does not show it again.
        for (int i = 0; i < previous.length(); i++) {
            String id = previous.getJSONObject(i).getString("id"), delivered = prefs(c).getString("delivered:" + id, "");
            if (!id.contains("@") || delivered.isEmpty()) continue;
            String series = "delivered:" + id.substring(0, id.lastIndexOf('@'));
            if (dateOf(delivered).compareTo(dateOf(prefs(c).getString(series, ""))) > 0) prefs(c).edit().putString(series, delivered).commit();
        }
        for (int i = 0; i < previous.length(); i++) {
            JSONObject old = previous.getJSONObject(i);
            String id = old.getString("id");
            manager.cancel(alarm(c, id));
            String delivered = prefs(c).getString("delivered:" + id, "");
            boolean kept = false;
            for (int j = 0; j < next.length(); j++) {
                JSONObject candidate = next.getJSONObject(j);
                if (id.equals(candidate.optString("id")) && retained(candidate, delivered)) kept = true;
            }
            if (!kept) {
                NotificationManagerCompat.from(c).cancel(id, 1);
                prefs(c).edit().remove("delivered:" + id).apply();
            }
        }
        reschedule(c);
    }
    /** Sets the event's one alarm; false once Android's alarm cap is reached. */
    static boolean schedule(Context c, AlarmManager manager, JSONObject event) {
        String id = event.optString("id");
        long now = System.currentTimeMillis();
        String date = pending(c, event, now);
        manager.cancel(alarm(c, id));
        if (date == null) return true;
        // No exact-alarm permission is required. Android may defer delivery
        // under battery restrictions; the event form explains this clearly.
        // Android caps pending alarms per app; past the cap keep the ones
        // already set (the list is soonest first) instead of crashing.
        try { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, nextDelivery(due(event, date), now), alarm(c, id)); return true; }
        catch (IllegalStateException | SecurityException full) { return false; }
    }
    static synchronized void reschedule(Context c) {
        AlarmManager manager = (AlarmManager)c.getSystemService(Context.ALARM_SERVICE);
        JSONArray list = events(c);
        for (int i = 0; i < list.length(); i++) {
            JSONObject event = list.optJSONObject(i);
            if (event != null && !schedule(c, manager, event)) break;
        }
    }
    @Override public void onReceive(Context c, Intent intent) {
        if (!"memora.PLANNER_REMINDER".equals(intent.getAction())) { reschedule(c); return; }
        synchronized (PlannerReminderReceiver.class) {
            String id = intent.getStringExtra("id");
            JSONArray list = events(c);
            for (int i = 0; i < list.length(); i++) {
                JSONObject event = list.optJSONObject(i);
                if (event == null || !event.optString("id").equals(id)) continue;
                long now = System.currentTimeMillis();
                String date = pending(c, event, now);
                if (date == null) return;
                if (due(event, date) > now) { reschedule(c); return; }
                // Mark it handled even when it cannot be shown, so the alarm
                // moves on to the next date instead of stopping here.
                prefs(c).edit().putString("delivered:" + id, signature(event, date)).commit();
                show(c, id, event);
                schedule(c, (AlarmManager)c.getSystemService(Context.ALARM_SERVICE), event);
                return;
            }
        }
    }
    static void show(Context c, String id, JSONObject event) {
        NotificationManager manager = (NotificationManager)c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(CHANNEL, event.optString("channel", "Planner reminders"), NotificationManager.IMPORTANCE_DEFAULT));
        if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return;
        Intent open = new Intent(c, MainActivity.class).putExtra("plannerReminder", true).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(c, 17, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            manager.notify(id, 1, new NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_my_calendar).setContentTitle(event.optString("channel", "Planner reminders"))
                .setContentText(event.optString("body", "An event is coming up. Open Planner."))
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setContentIntent(tap).setAutoCancel(true).build());
        } catch (SecurityException ignored) { /* Permission can be revoked after scheduling. */ }
    }
}
