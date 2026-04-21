// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
fn configure_wsl_graphics() {
    use std::{env, fs};

    let is_wsl = env::var_os("WSL_DISTRO_NAME").is_some()
        || fs::read_to_string("/proc/version")
            .map(|content| content.to_ascii_lowercase().contains("microsoft"))
            .unwrap_or(false);

    if !is_wsl {
        return;
    }

    // WSLg sometimes exposes a broken EGL/Zink path for WebKitGTK.
    // Prefer software rendering unless the user has explicitly overridden it.
    if env::var_os("LIBGL_ALWAYS_SOFTWARE").is_none() {
        unsafe { env::set_var("LIBGL_ALWAYS_SOFTWARE", "1") };
    }
    if env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        unsafe { env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_wsl_graphics() {}

fn main() {
    configure_wsl_graphics();
    llminocr_lib::run();
}
