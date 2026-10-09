package io.github.raezd.liftlog;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin lives in this project, so it's registered by hand.
        registerPlugin(RestAlarmPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
