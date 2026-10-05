package com.digidream.qpainter;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
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

    // ---- folders: export a sky into a game module (assets/textures/*.png + module.txt) ----

    /** Shows the folder picker. Resolves {uri} (the folder, with lasting read/write access) or {} if cancelled. */
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        String initial = call.getString("initial");
        if (initial != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) i.putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(initial));
        startActivityForResult(call, i, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        Uri uri = picked(result);
        JSObject o = new JSObject();
        if (uri != null) o.put("uri", uri.toString());
        call.resolve(o);
    }

    /** Text of `path` (like "module.txt") inside a picked folder: {text}, or {} if there's no such file. */
    @PluginMethod
    public void readText(PluginCall call) {
        try {
            Uri doc = resolve(Uri.parse(call.getString("tree")), call.getString("path"), false, null);
            JSObject o = new JSObject();
            if (doc != null) {
                try (InputStream in = getContext().getContentResolver().openInputStream(doc)) {
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    byte[] chunk = new byte[65536];
                    for (int n; (n = in.read(chunk)) > 0; ) buf.write(chunk, 0, n);
                    o.put("text", buf.toString("UTF-8"));
                }
            }
            call.resolve(o);
        } catch (Exception e) {
            call.reject("Couldn't read: " + e.getMessage());
        }
    }

    /** Writes `data` (base64) to `path` inside a picked folder, creating folders and the file as needed. */
    @PluginMethod
    public void writePath(PluginCall call) {
        try {
            Uri doc = resolve(Uri.parse(call.getString("tree")), call.getString("path"), true, call.getString("mime", "application/octet-stream"));
            write(doc, call.getString("data", ""));
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't write " + call.getString("path") + ": " + e.getMessage());
        }
    }

    /** The document at a slash-separated path under a tree; with `create`, missing folders and the file are made. */
    private Uri resolve(Uri tree, String path, boolean create, String mime) throws Exception {
        String parent = DocumentsContract.getTreeDocumentId(tree);
        String[] parts = path.split("/");
        for (int i = 0; i < parts.length; i++) {
            boolean last = i == parts.length - 1;
            String id = child(tree, parent, parts[i]);
            if (id == null) {
                if (!create) return null;
                Uri made = DocumentsContract.createDocument(getContext().getContentResolver(),
                    DocumentsContract.buildDocumentUriUsingTree(tree, parent),
                    last ? mime : DocumentsContract.Document.MIME_TYPE_DIR, parts[i]);
                if (made == null) throw new Exception("couldn't create " + parts[i]);
                id = DocumentsContract.getDocumentId(made);
            }
            parent = id;
        }
        return DocumentsContract.buildDocumentUriUsingTree(tree, parent);
    }

    private String child(Uri tree, String parentId, String name) {
        Uri kids = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME };
        try (Cursor c = getContext().getContentResolver().query(kids, cols, null, null, null)) {
            while (c != null && c.moveToNext()) if (name.equals(c.getString(1))) return c.getString(0);
        }
        return null;
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
