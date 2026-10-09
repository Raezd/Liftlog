package io.github.raezd.liftlog;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;

/**
 * Everything the rest alert shares between the two scheduling paths: the
 * notification channels, the notification itself, and in-app playback.
 *
 * Android locks a channel's sound and vibration once the channel exists on a
 * phone, so any change to those means a new channel id (rest-timer-v2, ...).
 */
final class RestAlerts {
    /** Follows the ringer: sound and vibration normally, vibration only on vibrate or silent. */
    static final String CHANNEL_DEFAULT = "rest-timer-v1";
    /** Same sound on the alarm stream, which plays even on vibrate or silent. */
    static final String CHANNEL_ALARM = "rest-timer-alarm-v1";

    static final long[] VIBRATION = {0, 700, 250, 700, 250, 700};

    /** True while the app's screen is in front. Set by RestAlarmPlugin. */
    static volatile boolean foreground = false;

    private RestAlerts() {}

    static Uri soundUri(Context ctx) {
        return Uri.parse("android.resource://" + ctx.getPackageName() + "/" + R.raw.rest_alert);
    }

    static AudioAttributes audio(boolean alarmStream) {
        return new AudioAttributes.Builder()
            .setUsage(alarmStream ? AudioAttributes.USAGE_ALARM : AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
    }

    static void ensureChannels(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(channel(ctx, CHANNEL_DEFAULT, "Rest timer", false));
        nm.createNotificationChannel(channel(ctx, CHANNEL_ALARM, "Rest timer (alarm sound)", true));
    }

    private static NotificationChannel channel(Context ctx, String id, String name, boolean alarmStream) {
        NotificationChannel ch = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(alarmStream
            ? "Plays when rest is over, even with the phone on vibrate or silent."
            : "Plays when rest is over. Follows your ringer setting.");
        ch.setSound(soundUri(ctx), audio(alarmStream));
        ch.enableVibration(true);
        ch.setVibrationPattern(VIBRATION);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ch.setShowBadge(false);
        return ch;
    }

    static String channelFor(boolean alarmStream) {
        return alarmStream ? CHANNEL_ALARM : CHANNEL_DEFAULT;
    }

    /** Opens the app when the notification is tapped. */
    static PendingIntent openApp(Context ctx) {
        Intent i = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (i == null) i = new Intent(ctx, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** The broadcast AlarmManager fires for path B. Same id, same PendingIntent, so cancel matches. */
    static PendingIntent fireIntent(Context ctx, int id, String title, String body, boolean alarmStream) {
        Intent i = new Intent(ctx, RestAlarmReceiver.class);
        i.setAction("io.github.raezd.liftlog.REST_ALARM");
        i.setData(Uri.parse("liftlog-rest://" + id));
        if (title != null) {
            i.putExtra("id", id);
            i.putExtra("title", title);
            i.putExtra("body", body);
            i.putExtra("alarmStream", alarmStream);
        }
        return PendingIntent.getBroadcast(ctx, id, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static boolean canScheduleExact(Context ctx) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || ctx.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    static void post(Context ctx, int id, String title, String body, boolean alarmStream) {
        Notification n = new Notification.Builder(ctx, channelFor(alarmStream))
            .setSmallIcon(R.drawable.ic_stat_rest)
            .setColor(0xFFD2792B)
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx))
            .build();
        try {
            ctx.getSystemService(NotificationManager.class).notify(id, n);
        } catch (SecurityException ignored) {
            // Notification permission was turned off. The app shows how to fix it.
        }
    }

    /**
     * The alert while the app is open: the same sound and vibration, without a
     * notification. Uses the same audio usage as the channel, so it follows
     * the ringer the same way.
     */
    static void playInApp(Context ctx, boolean alarmStream) {
        AudioManager am = ctx.getSystemService(AudioManager.class);
        AudioAttributes attrs = audio(alarmStream);
        AudioFocusRequest focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(attrs)
            .build();
        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(attrs);
            mp.setDataSource(ctx, soundUri(ctx));
            mp.setOnCompletionListener(p -> {
                p.release();
                am.abandonAudioFocusRequest(focus);
            });
            mp.prepare();
            am.requestAudioFocus(focus);
            mp.start();
        } catch (Exception ignored) {
            am.abandonAudioFocusRequest(focus);
        }
        Vibrator v = ctx.getSystemService(Vibrator.class);
        if (v != null && v.hasVibrator()) {
            v.vibrate(VibrationEffect.createWaveform(VIBRATION, -1), attrs);
        }
    }
}
