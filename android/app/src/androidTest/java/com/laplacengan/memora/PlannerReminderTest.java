package com.laplacengan.memora;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import android.content.Intent;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;

@RunWith(AndroidJUnit4.class)
public class PlannerReminderTest {
    @Test public void resumeRetainsRecentlyDeferredReminders() {
        long now = 200000000L;
        assertEquals(now + 60000, PlannerReminderReceiver.nextDelivery(now + 60000, now));
        assertEquals(now, PlannerReminderReceiver.nextDelivery(now - 60000, now));
        assertEquals(-1, PlannerReminderReceiver.nextDelivery(now - 86400001L, now));
        assertEquals(-1, PlannerReminderReceiver.nextDelivery(-1, now));
    }
    @Test public void localReminderFollowsTimezoneAndRejectsInvalidDate() throws Exception {
        TimeZone original = TimeZone.getDefault();
        try {
            JSONObject event = new JSONObject("{\"date\":\"2030-01-10\",\"start\":\"09:00\",\"remindBefore\":15}");
            TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
            long utc = PlannerReminderReceiver.due(event, event.getString("date"));
            TimeZone.setDefault(TimeZone.getTimeZone("America/Los_Angeles"));
            assertEquals(8 * 3600000L, PlannerReminderReceiver.due(event, event.getString("date")) - utc);
            event.put("date", "2030-02-30");
            assertEquals(-1, PlannerReminderReceiver.due(event, event.getString("date")));
        } finally { TimeZone.setDefault(original); }
    }
    @Test public void replacementAndDeletionSurviveStoredScheduleReload() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        JSONArray original = PlannerReminderReceiver.events(context);
        String id = "instrumented-reminder-check";
        try {
            JSONObject event = new JSONObject("{\"id\":\"instrumented-reminder-check\",\"date\":\"2030-01-10\",\"start\":\"09:00\",\"remindBefore\":15}");
            PlannerReminderReceiver.replace(context, new JSONArray().put(event));
            assertEquals(id, PlannerReminderReceiver.events(context).getJSONObject(0).getString("id"));
            event.put("start", "10:00");
            PlannerReminderReceiver.replace(context, new JSONArray().put(event));
            assertEquals(1, PlannerReminderReceiver.events(context).length());
            assertEquals("10:00", PlannerReminderReceiver.events(context).getJSONObject(0).getString("start"));
            PlannerReminderReceiver.replace(context, new JSONArray());
            assertEquals(0, PlannerReminderReceiver.events(context).length());
        } finally { PlannerReminderReceiver.replace(context, original); }
    }
    static String day(int offset) {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new java.util.Date(System.currentTimeMillis() + offset * 86400000L));
    }
    static JSONObject series(String id, String start, int... offsets) throws Exception {
        JSONArray dates = new JSONArray();
        for (int o : offsets) dates.put(day(o));
        return new JSONObject().put("id", id).put("date", dates.getString(0)).put("start", start).put("remindBefore", 0).put("dates", dates);
    }
    @Test public void aRepeatingEventMovesOnToItsNextDateAfterEachReminder() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        JSONArray original = PlannerReminderReceiver.events(context);
        String id = "instrumented-series";
        try {
            String earlier = new SimpleDateFormat("HH:mm", Locale.US).format(new java.util.Date(System.currentTimeMillis() - 3600000L));
            if (earlier.compareTo(new SimpleDateFormat("HH:mm", Locale.US).format(new java.util.Date())) > 0) earlier = "00:00";
            JSONObject event = series(id, earlier, 0, 1, 2);
            PlannerReminderReceiver.replace(context, new JSONArray().put(event));
            long now = System.currentTimeMillis();
            // Today's time has passed (an hour ago): it is due now.
            assertEquals(day(0), PlannerReminderReceiver.pending(context, event, now));
            new PlannerReminderReceiver().onReceive(context, new Intent("memora.PLANNER_REMINDER").putExtra("id", id));
            assertEquals(day(0) + "|" + earlier + "|0", PlannerReminderReceiver.prefs(context).getString("delivered:" + id, ""));
            assertEquals(day(1), PlannerReminderReceiver.pending(context, event, now));
            // The app reopening with the same window keeps what was shown.
            PlannerReminderReceiver.replace(context, new JSONArray().put(event));
            assertEquals(day(1), PlannerReminderReceiver.pending(context, event, now));
            // A time a day ahead fires early only if Android wakes us early: stays put.
            new PlannerReminderReceiver().onReceive(context, new Intent("memora.PLANNER_REMINDER").putExtra("id", id));
            assertEquals(day(1), PlannerReminderReceiver.pending(context, event, now));
            // The window moving past the shown date keeps the series going.
            JSONObject later = series(id, earlier, 1, 2, 3);
            PlannerReminderReceiver.replace(context, new JSONArray().put(later));
            assertEquals(day(1), PlannerReminderReceiver.pending(context, later, now));
            // Deleting the event forgets it.
            PlannerReminderReceiver.replace(context, new JSONArray());
            assertEquals("", PlannerReminderReceiver.prefs(context).getString("delivered:" + id, ""));
        } finally { PlannerReminderReceiver.replace(context, original); }
    }
    @Test public void aDeferredAlarmShowsOnceForTheLatestMissedDate() throws Exception {
        JSONObject event = new JSONObject("{\"id\":\"x\",\"start\":\"09:00\",\"remindBefore\":0,\"dates\":[\"2030-01-01\",\"2030-01-02\",\"2030-01-03\",\"2030-01-04\"]}");
        long now = PlannerReminderReceiver.due(event, "2030-01-03") + 3600000L;
        // The 1st is too old, the 2nd and 3rd were missed: show the 3rd only.
        assertEquals("2030-01-03", PlannerReminderReceiver.pending(ApplicationProvider.getApplicationContext(), event, now));
        // Before any is due, the soonest is next.
        assertEquals("2030-01-01", PlannerReminderReceiver.pending(ApplicationProvider.getApplicationContext(), event, PlannerReminderReceiver.due(event, "2030-01-01") - 1));
    }
    @Test public void aChangedTimeClearsWhatWasShownButAMovedWindowDoesNot() throws Exception {
        JSONObject event = new JSONObject("{\"id\":\"x\",\"start\":\"09:00\",\"remindBefore\":5,\"dates\":[\"2030-01-02\",\"2030-01-03\"]}");
        assertTrue(PlannerReminderReceiver.retained(event, "2030-01-02|09:00|5"));
        assertTrue(PlannerReminderReceiver.retained(event, "2030-01-01|09:00|5"));
        assertFalse(PlannerReminderReceiver.retained(event, "2030-01-02|08:00|5"));
        JSONObject once = new JSONObject("{\"id\":\"y\",\"date\":\"2030-01-05\",\"start\":\"09:00\",\"remindBefore\":5}");
        assertTrue(PlannerReminderReceiver.retained(once, "2030-01-05|09:00|5"));
        assertFalse(PlannerReminderReceiver.retained(once, "2030-01-04|09:00|5"));
    }
    @Test public void updatingFromPerDateAlarmsDoesNotRepeatWhatWasShown() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        JSONArray original = PlannerReminderReceiver.events(context);
        try {
            JSONObject old = new JSONObject().put("id", "migrated@" + day(0)).put("date", day(0)).put("start", "00:00").put("remindBefore", 0);
            PlannerReminderReceiver.prefs(context).edit().putString("events", new JSONArray().put(old).toString())
                .putString("delivered:migrated@" + day(0), day(0) + "|00:00|0").commit();
            JSONObject event = series("migrated", "00:00", 0, 1);
            PlannerReminderReceiver.replace(context, new JSONArray().put(event));
            assertEquals(day(1), PlannerReminderReceiver.pending(context, event, System.currentTimeMillis()));
            assertEquals("", PlannerReminderReceiver.prefs(context).getString("delivered:migrated@" + day(0), ""));
        } finally { PlannerReminderReceiver.replace(context, original); }
    }
}
