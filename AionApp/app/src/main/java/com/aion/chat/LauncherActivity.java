package com.aion.chat;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

/**
 * 启动页 — 选择连接地址（家庭WiFi / 户外Tailscale）
 */
public class LauncherActivity extends AppCompatActivity {

    private static final String PREFS       = "aion_prefs";
    private static final String KEY_URL     = "saved_url";
    private static final String KEY_AUTO    = "auto_connect";

    // ★ 在这里修改你的两个地址
    private static final String URL_HOME    = "http://192.168.xx.xxx:8080/chat";
    private static final String URL_OUTDOOR = "http://192.168.xx.xxx:8080/chat";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        // 如果上次勾选了"记住选择"，直接跳转
        if (prefs.getBoolean(KEY_AUTO, false)) {
            String savedUrl = prefs.getString(KEY_URL, URL_HOME);
            launchWebView(savedUrl);
            return;
        }

        setContentView(R.layout.activity_launcher);

        TextView tvHome    = findViewById(R.id.tvHomeUrl);
        TextView tvOutdoor = findViewById(R.id.tvOutdoorUrl);
        Button   btnHome   = findViewById(R.id.btnHome);
        Button   btnOutdoor= findViewById(R.id.btnOutdoor);
        CheckBox cbRemember= findViewById(R.id.cbRemember);

        tvHome.setText(URL_HOME);
        tvOutdoor.setText(URL_OUTDOOR);

        btnHome.setOnClickListener(v -> {
            saveIfNeeded(prefs, cbRemember.isChecked(), URL_HOME);
            launchWebView(URL_HOME);
        });

        btnOutdoor.setOnClickListener(v -> {
            saveIfNeeded(prefs, cbRemember.isChecked(), URL_OUTDOOR);
            launchWebView(URL_OUTDOOR);
        });
    }

    private void saveIfNeeded(SharedPreferences prefs, boolean remember, String url) {
        SharedPreferences.Editor editor = prefs.edit();
        editor.putString(KEY_URL, url);
        editor.putBoolean(KEY_AUTO, remember);
        editor.apply();
    }

    private void launchWebView(String url) {
        // 启动前台推送服务
        startPushService(url);

        Intent intent = new Intent(this, WebViewActivity.class);
        intent.putExtra("url", url);
        startActivity(intent);
        finish();
    }

    private void startPushService(String url) {
        // 启动前台服务（权限请求移到 WebViewActivity，因为本 Activity 会立即 finish）
        Intent serviceIntent = new Intent(this, AionPushService.class);
        serviceIntent.putExtra("url", url);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }
    }
}
