/// Whether this machine will actually deliver `almosthadai://` to us.
///
/// The front end asks before offering to sign in. Sending someone into a
/// browser consent flow whose result cannot come back is worse than telling
/// them up front that it cannot: the flow *appears* to work right up until
/// nothing happens, and every retry burns a single-use OAuth state.
#[tauri::command]
fn deep_link_registered(app: tauri::AppHandle) -> bool {
    #[cfg(desktop)]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        // An error asking the question is not a "yes".
        return app.deep_link().is_registered("almosthadai").unwrap_or(false);
    }

    #[cfg(not(desktop))]
    {
        let _ = app;
        true
    }
}

/// The desktop shell.
///
/// It does almost nothing on purpose: the window is a webview, and everything
/// the user interacts with is the React app. What the shell must own is the
/// three things a webview cannot do for itself. It drives the window, opens a
/// URL in the system browser, and receives the `almosthadai://` deep link the
/// sign-in flow hands back.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance FIRST, and only on desktop.
    //
    // Without it, Windows launches a second copy of the app to deliver the
    // sign-in deep link, and the session lands in a process the user is not
    // looking at. The plugin's deep-link feature forwards the URL to the
    // running instance instead, which is where the waiting screen is.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|_app| {
            // Registering the scheme at runtime is what makes `npm run tauri dev`
            // able to receive a callback; an installed build gets the same
            // association from the NSIS installer.
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                // NOT best-effort-and-forget. This registration is what lets
                // sign-in finish at all: without it Twitch consent succeeds,
                // the server redirects to `almosthadai://auth`, Windows has
                // nowhere to deliver it, and the user is left retrying a link
                // whose one-use state is already spent, an undiagnosable loop
                // whose only visible symptom is "this authorization link is no
                // longer valid". Swallowing the error here is what would make
                // that loop impossible to explain, so it is logged loudly and
                // the front end is told, rather than the app pretending it can
                // complete a flow it cannot.
                if let Err(error) = _app.deep_link().register_all() {
                    eprintln!(
                        "WARNING: could not register the almosthadai:// URI scheme ({error}). \
                         Sign-in cannot complete until it is registered."
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![deep_link_registered])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
