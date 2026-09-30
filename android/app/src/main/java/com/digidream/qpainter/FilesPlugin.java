package com.digidream.qpainter;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Save/open through Android's system file picker (Storage Access Framework).
 * The app keeps permission to picked files, so later saves can overwrite them without asking again.
 * Data crosses the bridge as base64.
 */
@CapacitorPlugin(name = "Files")
public class FilesPlugin extends Plugin {

    /** Shows "Save to…" for a new file, writes `data` to it. Resolves {} if the user cancels. */
    @PluginMethod
    public void create(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(call.getString("mime", "application/octet-stream"))
            .putExtra(Intent.EXTRA_TITLE, call.getString("name", "file"));
        startActivityForResult(call, i, "created");
    }

    @ActivityCallback
    private void created(PluginCall call, ActivityResult result) {
        Uri uri = picked(result);
        if (uri == null) { call.resolve(new JSObject()); return; }
        try {
            write(uri, call.getString("data", ""));
            call.resolve(describe(uri));
        } catch (Exception e) {
            call.reject("Couldn't write file: " + e.getMessage());
        }
    }

    /** Overwrites a previously picked file. */
    @PluginMethod
    public void write(PluginCall call) {
        try {
            write(Uri.parse(call.getString("uri")), call.getString("data", ""));
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't write file: " + e.getMessage());
        }
    }

    /** Shows the file picker. Resolves {uri, name, data} or {} if cancelled. */
    @PluginMethod
    public void open(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        startActivityForResult(call, i, "opened");
    }

    @ActivityCallback
    private void opened(PluginCall call, ActivityResult result) {
        Uri uri = picked(result);
        if (uri == null) { call.resolve(new JSObject()); return; }
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[65536];
            for (int n; (n = in.read(chunk)) > 0; ) buf.write(chunk, 0, n);
            JSObject out = describe(uri);
            out.put("data", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Couldn't read file: " + e.getMessage());
        }
    }

    private Uri picked(ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) return null;
        Uri uri = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // provider doesn't offer persistent access; the file still works for this session
        }
        return uri;
    }

    private void write(Uri uri, String base64) throws Exception {
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            out.write(Base64.decode(base64, Base64.DEFAULT));
        }
    }

    private JSObject describe(Uri uri) {
        JSObject o = new JSObject();
        o.put("uri", uri.toString());
        String name = uri.getLastPathSegment();
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) {}
        o.put("name", name);
        return o;
    }
}
