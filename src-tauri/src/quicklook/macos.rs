//! All AppKit objects stay on the main thread. The shared panel's unretained
//! delegate/data source are held until they have been explicitly detached.
use std::cell::{Cell, RefCell};
use std::path::Path;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSResponder, NSWindow,
    NSWindowDelegate, NSWindowDidResignMainNotification,
};
use objc2_foundation::{
    MainThreadMarker, NSNotification, NSNotificationCenter, NSObjectProtocol, NSString, NSURL,
};
use objc2_quick_look_ui::{
    QLPreviewItem, QLPreviewPanel, QLPreviewPanelDataSource, QLPreviewPanelDelegate,
};

type OnClose = Box<dyn Fn()>;

struct ControllerIvars {
    url: Retained<NSURL>,
    window: Retained<NSWindow>,
    active: Cell<bool>,
    controlled: Cell<bool>,
    closing: Cell<bool>,
    on_close: RefCell<Option<OnClose>>,
}

define_class!(
    // NSResponder has no additional subclass invariants; every method and ivar
    // is main-thread confined by MainThreadOnly.
    #[unsafe(super = NSResponder)]
    #[name = "AnyScpQuickLookResponder"]
    #[thread_kind = MainThreadOnly]
    #[ivars = ControllerIvars]
    struct PreviewController;

    unsafe impl NSObjectProtocol for PreviewController {}

    impl PreviewController {
        #[unsafe(method(ownerWindowResignedMain:))]
        fn owner_resigned(&self, _notification: &NSNotification) {
            // QLPreviewPanel can cache its controller when another Tauri window
            // becomes main. Observe only this owner; keep Tauri's delegate.
            if self.ivars().active.get() && self.ivars().controlled.get() {
                if let Some(panel) = unsafe { QLPreviewPanel::sharedPreviewPanel(self.mtm()) } {
                    self.order_out(&panel);
                }
                self.notify_closed();
            }
        }

        #[unsafe(method(acceptsPreviewPanelControl:))]
        fn accepts(&self, _panel: Option<&QLPreviewPanel>) -> bool {
            self.ivars().active.get() && self.ivars().window.isMainWindow()
        }

        #[unsafe(method(beginPreviewPanelControl:))]
        fn begin(&self, panel: &QLPreviewPanel) {
            self.ivars().controlled.set(true);
            // Only AppKit's controller handoff installs the data source.
            unsafe {
                panel.setDataSource(Some(ProtocolObject::from_ref(self)));
                panel.setDelegate(Some(self));
            }
        }

        #[unsafe(method(endPreviewPanelControl:))]
        fn end(&self, panel: &QLPreviewPanel) {
            self.ivars().controlled.set(false);
            unsafe {
                panel.setDataSource(None);
                panel.setDelegate(None);
            }
            if self.ivars().active.get() && panel.isVisible() { self.order_out(panel); }
            self.notify_closed();
        }
    }

    unsafe impl QLPreviewPanelDataSource for PreviewController {
        #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
        unsafe fn count(&self, _panel: Option<&QLPreviewPanel>) -> isize { 1 }

        #[unsafe(method_id(previewPanel:previewItemAtIndex:))]
        unsafe fn item(&self, _panel: Option<&QLPreviewPanel>, index: isize)
            -> Option<Retained<ProtocolObject<dyn QLPreviewItem>>> {
            (index == 0).then(|| ProtocolObject::from_retained(self.ivars().url.clone()))
        }
    }

    unsafe impl NSWindowDelegate for PreviewController {
        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, _notification: &NSNotification) {
            self.ivars().closing.set(true);
            self.notify_closed();
        }
    }

    unsafe impl QLPreviewPanelDelegate for PreviewController {
        #[unsafe(method(previewPanel:handleEvent:))]
        unsafe fn handle_event(&self, panel: Option<&QLPreviewPanel>, event: Option<&NSEvent>) -> bool {
            if event.is_some_and(is_close_key) {
                if !event.unwrap().isARepeat() {
                    if let Some(panel) = panel { self.close_panel(panel); }
                }
                true
            } else { false }
        }
    }
);

impl PreviewController {
    fn order_out(&self, panel: &QLPreviewPanel) {
        if !self.ivars().closing.replace(true) {
            panel.orderOut(None);
        }
    }

    fn close_panel(&self, panel: &QLPreviewPanel) {
        // Quick Look animates close asynchronously. A second close/orderOut
        // during that transition can reverse it and leave the panel visible.
        // Keep the session alive until windowWillClose/endPreviewPanelControl.
        if !self.ivars().closing.replace(true) {
            panel.close();
        }
    }

    fn notify_closed(&self) {
        if self.ivars().active.replace(false) {
            let callback = self.ivars().on_close.borrow_mut().take();
            if let Some(callback) = callback {
                callback();
            }
        }
    }
}

fn is_close_key(event: &NSEvent) -> bool {
    if event.r#type() != NSEventType::KeyDown {
        return false;
    }
    let modifiers = NSEventModifierFlags::Command
        | NSEventModifierFlags::Control
        | NSEventModifierFlags::Option
        | NSEventModifierFlags::Shift;
    matches!(event.keyCode(), 49 | 53) && !event.modifierFlags().intersects(modifiers)
}

struct NativeSession {
    id: String,
    controller: Retained<PreviewController>,
    window: Retained<NSWindow>,
    previous: Option<Retained<NSResponder>>,
    monitor: Retained<AnyObject>,
    panel: Retained<QLPreviewPanel>,
}

thread_local! {
    static SESSION: RefCell<Option<NativeSession>> = const { RefCell::new(None) };
}

/// Called by a main-thread Tauri dispatch, after the manager has rechecked the
/// request. No frontend-provided local path reaches this function.
pub fn show(
    window: &tauri::WebviewWindow,
    id: String,
    path: &Path,
    on_close: OnClose,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("Quick Look requires the main thread")?;
    let previous_owner = SESSION.with(|s| s.borrow().as_ref().map(|s| s.controller.clone()));
    if let Some(owner) = previous_owner {
        owner.notify_closed();
    }
    close(None);
    let pointer = window.ns_window().map_err(|e| e.to_string())?;
    // Tauri owns a live NSWindow; retaining it keeps the chain anchor valid.
    let window = unsafe { Retained::retain(pointer.cast::<NSWindow>()).ok_or("Missing NSWindow")? };
    let url = NSURL::fileURLWithPath(&NSString::from_str(
        path.to_str().ok_or("Invalid preview path")?,
    ));
    let controller = PreviewController::alloc(mtm).set_ivars(ControllerIvars {
        url,
        window: window.clone(),
        active: Cell::new(true),
        controlled: Cell::new(false),
        closing: Cell::new(false),
        on_close: RefCell::new(Some(on_close)),
    });
    let controller: Retained<PreviewController> = unsafe { msg_send![super(controller), init] };
    let panel =
        unsafe { QLPreviewPanel::sharedPreviewPanel(mtm).ok_or("Quick Look panel unavailable")? };
    let previous = unsafe { window.nextResponder() };
    unsafe {
        controller.setNextResponder(previous.as_deref());
        window.setNextResponder(Some(&controller));
    }
    window.makeKeyAndOrderFront(None);
    window.makeMainWindow();
    panel.makeKeyAndOrderFront(None);
    unsafe {
        panel.updateController();
    }
    if !controller.ivars().controlled.get() {
        controller.ivars().active.set(false);
        unsafe {
            window.setNextResponder(previous.as_deref());
            controller.setNextResponder(None);
        }
        panel.orderOut(None);
        unsafe {
            panel.updateController();
        }
        return Err("Quick Look did not grant responder control".into());
    }

    // A panel-specific local monitor runs *before* movie/audio views consume
    // Space. It never intercepts events sent to another window or the webview.
    let target = panel.clone();
    let owner = controller.clone();
    let handler = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let event_ref = unsafe { event.as_ref() };
        if owner.ivars().active.get()
            && event_ref.window(mtm).as_deref() == Some(&*target)
            && is_close_key(event_ref)
        {
            if !event_ref.isARepeat() {
                owner.close_panel(&target);
            }
            std::ptr::null_mut()
        } else {
            event.as_ptr()
        }
    });
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
    };
    let Some(monitor) = monitor else {
        controller.ivars().active.set(false);
        unsafe {
            panel.setDataSource(None);
            panel.setDelegate(None);
            window.setNextResponder(previous.as_deref());
            controller.setNextResponder(None);
        }
        panel.orderOut(None);
        unsafe {
            panel.updateController();
        }
        return Err("Could not monitor preview keyboard events".into());
    };
    unsafe {
        NSNotificationCenter::defaultCenter().addObserver_selector_name_object(
            &controller,
            sel!(ownerWindowResignedMain:),
            Some(NSWindowDidResignMainNotification),
            Some(&window),
        );
    }
    SESSION.with(|s| {
        *s.borrow_mut() = Some(NativeSession {
            id,
            controller,
            window,
            previous,
            monitor,
            panel: panel.clone(),
        })
    });
    unsafe {
        panel.reloadData();
    }
    panel.makeKeyAndOrderFront(None);
    Ok(())
}

/// `id` protects a newer panel from delayed cleanup. Detach native references
/// before callers release the staged file. Never change Tauri's window delegate.
pub fn close(id: Option<&str>) {
    let session = SESSION.with(|s| {
        let mut s = s.borrow_mut();
        if s.as_ref().is_some_and(|s| id.is_none_or(|id| s.id == id)) {
            s.take()
        } else {
            None
        }
    });
    if let Some(s) = session {
        s.controller.ivars().active.set(false);
        s.controller.ivars().on_close.borrow_mut().take();
        unsafe {
            NSNotificationCenter::defaultCenter().removeObserver(&s.controller);
            NSEvent::removeMonitor(&s.monitor);
            if s.controller.ivars().controlled.replace(false) {
                s.panel.setDataSource(None);
                s.panel.setDelegate(None);
                s.controller.order_out(&s.panel);
            }
            if s.window.nextResponder().as_deref() == Some(&*s.controller) {
                s.window.setNextResponder(s.previous.as_deref());
            }
            s.controller.setNextResponder(None);
            s.panel.updateController();
        }
    }
}
