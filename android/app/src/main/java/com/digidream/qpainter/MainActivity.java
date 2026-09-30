package com.digidream.qpainter;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FilesPlugin.class); // local plugin: system file picker for save/open
        super.onCreate(savedInstanceState);
    }
}
