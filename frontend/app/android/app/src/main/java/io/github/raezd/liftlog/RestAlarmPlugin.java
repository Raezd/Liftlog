package io.github.raezd.liftlog;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Rest timer plumbing the local notifications plugin doesn't cover: the
 * channels, in-app playback, and permission status. Scheduling itself uses the
 * local notifications plugin with allowWhileIdle (path A, chosen in Spec 2).
 */
@CapacitorPlugin(name = "RestAlarm")
public class RestAlarmPlugin extends Plugin {
    @Override
    public void load() {
        RestAlerts.ensureChannels(getContext());
        RestAlerts.foreground = true;
    }

    @Override
    protected void handleOnResume() {
        RestAlerts.foreground = true;
    }

    @Override
    protected void handleOnPause() {
        RestAlerts.foreground = false;
    }

    @PluginMethod
    public void status(PluginCall call) {
        Context ctx = getContext();
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        JSObject r = new JSObject();
        r.put("notifications", nm.areNotificationsEnabled());
        r.put("exactAlarms", RestAlerts.canScheduleExact(ctx));
        r.put("channelOn", channelOn(nm, RestAlerts.CHANNEL_DEFAULT));
        r.put("alarmChannelOn", channelOn(nm, RestAlerts.CHANNEL_ALARM));
        int mode = ctx.getSystemService(AudioManager.class).getRingerMode();
        r.put("ringer", mode == AudioManager.RINGER_MODE_NORMAL ? "normal"
            : mode == AudioManager.RINGER_MODE_VIBRATE ? "vibrate" : "silent");
        call.resolve(r);
    }

    private static boolean channelOn(NotificationManager nm, String id) {
        NotificationChannel ch = nm.getNotificationChannel(id);
        return ch != null && ch.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    /**
     * Returns whether the app is in front right now. The app uses this to take
     * over an alert just before it fires, so the phone never plays it twice.
     */
    @PluginMethod
    public void isForeground(PluginCall call) {
        JSObject r = new JSObject();
        r.put("foreground", RestAlerts.foreground);
        call.resolve(r);
    }

    /** The alert while the app is open. { alarmStream } */
    @PluginMethod
    public void playNow(PluginCall call) {
        RestAlerts.playInApp(getContext(), Boolean.TRUE.equals(call.getBoolean("alarmStream", false)));
        call.resolve();
    }

    /** { kind: "notifications" | "exactAlarms" | "app" } */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Context ctx = getContext();
        String kind = call.getString("kind", "app");
        Intent i;
        if ("notifications".equals(kind)) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName());
        } else if ("exactAlarms".equals(kind) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + ctx.getPackageName()));
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.getPackageName()));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
        call.resolve();
    }
}
