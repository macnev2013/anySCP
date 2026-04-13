use std::env;
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // ── Build FreeRDP from source via cmake ─────────────────────────────────
    let dst = cmake::Config::new("vendor/FreeRDP")
        .define("BUILD_SHARED_LIBS", "OFF")
        .define("WITH_SERVER", "OFF")
        .define("WITH_CLIENT", "OFF")
        .define("WITH_SAMPLE", "OFF")
        .define("WITH_X11", "OFF")
        .define("WITH_WAYLAND", "OFF")
        .define("WITH_MANPAGES", "OFF")
        .define("BUILD_TESTING", "OFF")
        .define("BUILD_TESTING_INTERNAL", "OFF")
        .define("WITH_FFMPEG", "OFF")
        .define("WITH_SWSCALE", "OFF")
        .define("WITH_CAIRO", "OFF")
        .define("WITH_JPEG", "OFF")
        .define("WITH_PULSE", "OFF")
        .define("WITH_ALSA", "OFF")
        .define("WITH_OSS", "OFF")
        .define("WITH_MACAUDIO", "OFF")
        .define("WITH_FUSE", "OFF")
        .define("WITH_CUPS", "OFF")
        .define("WITH_PCSC", "OFF")
        .define("WITH_PKCS11", "OFF")
        .define("WITH_OPUS", "OFF")
        .define("WITH_FAAC", "OFF")
        .define("WITH_FAAD2", "OFF")
        .define("WITH_SOXR", "OFF")
        .define("WITH_DSP_FFMPEG", "OFF")
        .define("WITH_LAME", "OFF")
        .define("WITH_GSM", "OFF")
        .define("WITH_JSONC", "OFF")
        .define("WITH_AAD", "OFF")
        .define("CMAKE_OSX_DEPLOYMENT_TARGET", "14.0")
        .define("WITH_CHANNELS", "ON")
        .define("WITH_CLIENT_COMMON", "ON")
        .define("WITH_CLIENT_CHANNELS", "ON")
        .define("CHANNEL_URBDRC", "OFF")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        // OpenSSL from Homebrew on macOS
        .define("OPENSSL_ROOT_DIR", openssl_root())
        .build();

    let lib_path = dst.join("lib");
    println!("cargo:rustc-link-search=native={}", lib_path.display());

    // Static libraries (order matters — dependents before dependencies)
    println!("cargo:rustc-link-lib=static=freerdp-client3");
    println!("cargo:rustc-link-lib=static=freerdp3");
    println!("cargo:rustc-link-lib=static=winpr3");
    println!("cargo:rustc-link-lib=static=winpr-tools3");

    // Link channel static libraries
    let channel_lib_path = lib_path.join("freerdp3");
    if channel_lib_path.exists() {
        println!("cargo:rustc-link-search=native={}", channel_lib_path.display());
    }

    // System dependencies — add OpenSSL library search path on macOS
    let ossl = openssl_root();
    if !ossl.is_empty() {
        println!("cargo:rustc-link-search=native={}/lib", ossl);
    }
    println!("cargo:rustc-link-lib=ssl");
    println!("cargo:rustc-link-lib=crypto");
    println!("cargo:rustc-link-lib=z");
    println!("cargo:rustc-link-lib=json-c");

    // json-c library path (required by WinPR)
    if cfg!(target_os = "macos") {
        for path in &["/opt/homebrew/opt/json-c/lib", "/usr/local/opt/json-c/lib"] {
            if std::path::Path::new(path).exists() {
                println!("cargo:rustc-link-search=native={}", path);
                break;
            }
        }
    }

    // macOS frameworks
    if cfg!(target_os = "macos") {
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=SystemConfiguration");
        println!("cargo:rustc-link-lib=framework=IOKit");
    }

    // ── Generate Rust FFI bindings via bindgen ──────────────────────────────
    let include_path = dst.join("include");
    let winpr_include = include_path.join("winpr3");
    let freerdp_include = include_path.join("freerdp3");

    let bindings = bindgen::Builder::default()
        .header("wrapper.h")
        .clang_arg(format!("-I{}", winpr_include.display()))
        .clang_arg(format!("-I{}", freerdp_include.display()))
        // Allow FreeRDP + WinPR symbols
        .allowlist_function("freerdp_.*")
        .allowlist_function("gdi_.*")
        .allowlist_function("WaitForMultipleObjects")
        .allowlist_function("WaitForSingleObject")
        .allowlist_type("rdp.*")
        .allowlist_type("freerdp.*")
        .allowlist_type("RDP_CLIENT_ENTRY_POINTS.*")
        .allowlist_type("PIXEL_FORMAT_.*")
        .allowlist_var("PIXEL_FORMAT_.*")
        .allowlist_var("PTR_FLAGS_.*")
        .allowlist_var("KBD_FLAGS_.*")
        .allowlist_var("FreeRDP_.*")
        .allowlist_var("RDP_CLIENT_INTERFACE_VERSION")
        // Make all types derive Debug where possible
        .derive_debug(true)
        .derive_default(true)
        // Disable layout tests that may fail across platforms
        .layout_tests(false)
        .generate()
        .expect("Failed to generate FreeRDP bindings");

    let out_path = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out_path.join("freerdp_bindings.rs"))
        .expect("Couldn't write bindings");
}

fn openssl_root() -> String {
    if cfg!(target_os = "macos") {
        // Try Homebrew paths
        for path in &[
            "/opt/homebrew/opt/openssl@3",
            "/opt/homebrew/opt/openssl",
            "/usr/local/opt/openssl@3",
            "/usr/local/opt/openssl",
        ] {
            if std::path::Path::new(path).exists() {
                return path.to_string();
            }
        }
    }
    // Fall back to system default
    String::new()
}
