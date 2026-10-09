package io.github.raezd.liftlog;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Path B: AlarmManager.setAlarmClock fires this when rest is over. */
public class RestAlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        RestAlerts.post(
            ctx,
            intent.getIntExtra("id", 0),
            intent.getStringExtra("title"),
            intent.getStringExtra("body"),
            intent.getBooleanExtra("alarmStream", false)
        );
    }
}
