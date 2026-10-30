//! Native smoke probe, never registered as app IPC. Run on a logged-in Mac:
//! cargo run --example quicklook_probe
#[cfg(target_os = "macos")]
#[path = "../src/quicklook/macos.rs"]
mod macos;

#[cfg(target_os = "macos")]
fn main() {
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{MainThreadMarker, NSPoint, NSString};
    use objc2_quick_look_ui::QLPreviewPanel;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let fixture = tempfile::tempdir().unwrap();
    let path = fixture.path().join("Quick Look 測試.txt");
    let path = if let Some(source) = std::env::args_os().nth(1) {
        let source = std::path::PathBuf::from(source);
        let target = fixture.path().join(source.file_name().unwrap());
        std::fs::copy(source, &target).unwrap();
        target
    } else {
        std::fs::write(&path, "anySCP native Quick Look responder probe\n").unwrap();
        path
    };
    let closed = Arc::new(AtomicUsize::new(0));
    tauri::Builder::default().setup(move |app| {
        let window = WebviewWindowBuilder::new(app, "probe", WebviewUrl::App("index.html".into()))
            .title("anySCP Quick Look native probe").build()?;
        let other = WebviewWindowBuilder::new(app, "other", WebviewUrl::App("index.html".into()))
            .title("Quick Look control handoff probe").visible(false).build()?;
        let handle = app.handle().clone();
        let closed = closed.clone();
        std::thread::spawn(move || {
            // Keep fixture alive for every preview.
            let _fixture = fixture;
            for cycle in 0..20 {
                std::thread::sleep(Duration::from_millis(350));
                let w = window.clone();
                let p = path.clone();
                let counter = closed.clone();
                let cleanup = handle.clone();
                let (tx, rx) = std::sync::mpsc::channel();
                handle.run_on_main_thread(move || {
                    let result = macos::show(&w, cycle.to_string(), &p, Box::new(move || {
                        counter.fetch_add(1, Ordering::SeqCst);
                        // Match the manager: detach promptly from a background
                        // task, while AppKit may still be finishing its close.
                        // Deferring this until the assertion hid double-close bugs.
                        let cleanup = cleanup.clone();
                        std::thread::spawn(move || {
                            cleanup.run_on_main_thread(move || macos::close(Some(&cycle.to_string()))).unwrap();
                        });
                    }));
                    tx.send(result).unwrap();
                }).unwrap();
                rx.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
                std::thread::sleep(Duration::from_millis(400));
                let other = other.clone();
                let (tx, rx) = std::sync::mpsc::channel();
                handle.run_on_main_thread(move || {
                    let mtm = MainThreadMarker::new().unwrap();
                    let panel = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm).unwrap() };
                    assert!(panel.isVisible(), "panel not visible in cycle {cycle}");
                    assert!(unsafe { panel.currentController() }.is_some());
                    assert!(unsafe { panel.currentPreviewItem() }.is_some());
                    if cycle % 4 == 3 {
                            let pointer = other.ns_window().unwrap();
                            let other = unsafe { &*pointer.cast::<objc2_app_kit::NSWindow>() };
                            other.makeKeyAndOrderFront(None);
                            other.makeMainWindow();
                            unsafe { panel.updateController(); }

                        } else if cycle % 4 == 2 {
                        panel.performClose(None);
                    } else {
                        let key = if cycle % 4 == 0 { " " } else { "\u{1b}" };
                        let text = NSString::from_str(key);
                        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                            NSEventType::KeyDown, NSPoint::ZERO, NSEventModifierFlags::empty(), 0.0,
                            panel.windowNumber(), None, &text, &text, false,
                            if cycle % 4 == 0 { 49 } else { 53 },
                        ).unwrap();
                        NSApplication::sharedApplication(mtm).postEvent_atStart(&event, false);
                        // A physical key press also releases the key; exercise
                        // that event even when the panel is closing asynchronously.
                        let release = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                            NSEventType::KeyUp, NSPoint::ZERO, NSEventModifierFlags::empty(), 0.1,
                            panel.windowNumber(), None, &text, &text, false,
                            if cycle % 4 == 0 { 49 } else { 53 },
                        ).unwrap();
                        NSApplication::sharedApplication(mtm).postEvent_atStart(&release, false);
                    }
                    tx.send(()).unwrap();
                }).unwrap();
                rx.recv_timeout(Duration::from_secs(10)).unwrap();
                std::thread::sleep(Duration::from_millis(250));
                assert_eq!(closed.load(Ordering::SeqCst), cycle + 1, "close callback missing");
                let (tx, rx) = std::sync::mpsc::channel();
                handle.run_on_main_thread(move || {
                    let panel = unsafe { QLPreviewPanel::sharedPreviewPanel(MainThreadMarker::new().unwrap()).unwrap() };
                    assert!(!panel.isVisible(), "closed/control-loss panel must be hidden");
                    macos::close(Some(&cycle.to_string()));
                    tx.send(()).unwrap();
                }).unwrap();
                rx.recv_timeout(Duration::from_secs(10)).unwrap();
                eprintln!("Quick Look native cycle {}/20 passed", cycle + 1);
            }
            eprintln!("PASS: 20 native show/control/Space/Esc/close/control-loss/cleanup cycles");
            handle.exit(0);
        });
        Ok(())
    }).build(tauri::generate_context!()).unwrap().run(|_, _| {});
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Native Quick Look probe requires macOS");
}
