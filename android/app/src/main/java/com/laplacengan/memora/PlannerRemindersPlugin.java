package com.laplacengan.memora;

import android.Manifest;
import android.os.Build;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;

@CapacitorPlugin(name = "PlannerReminders", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class PlannerRemindersPlugin extends Plugin {
    @PluginMethod public void status(PluginCall call) {
        JSObject result = new JSObject();
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT >= 26) {
            android.app.NotificationManager manager = (android.app.NotificationManager)getContext().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
            android.app.NotificationChannel channel = manager.getNotificationChannel(PlannerReminderReceiver.CHANNEL);
            enabled = enabled && (channel == null || channel.getImportance() != android.app.NotificationManager.IMPORTANCE_NONE);
        }
        result.put("enabled", enabled);
        result.put("approximate", true);
        call.resolve(result);
    }
    @PluginMethod public void enable(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED)
            requestPermissionForAlias("notifications", call, "permissionResult");
        else status(call);
    }
    @PermissionCallback private void permissionResult(PluginCall call) { status(call); }
    @PluginMethod public void settings(PluginCall call) {
        Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + getContext().getPackageName()));
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                try {
                    getActivity().startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName()));
                } catch (ActivityNotFoundException missing) {
                    getActivity().startActivity(details);
                }
            } else getActivity().startActivity(details);
            call.resolve();
        } catch (ActivityNotFoundException missing) {
            call.reject("Notification settings are unavailable on this device", missing);
        }
    }
    @PluginMethod public void replace(PluginCall call) {
        try { PlannerReminderReceiver.replace(getContext(), call.getArray("events", new JSArray())); call.resolve(); }
        catch (Exception e) { call.reject("Could not save reminders", e); }
    }
    @PluginMethod public void consumeOpen(PluginCall call) {
        boolean open = getActivity().getIntent().getBooleanExtra("plannerReminder", false);
        getActivity().getIntent().removeExtra("plannerReminder");
        JSObject result = new JSObject(); result.put("open", open); call.resolve(result);
    }
}
