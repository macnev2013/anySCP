/// FreeRDP 3.x safe Rust wrapper.
///
/// Safety contract:
/// - All C callbacks run on the single OS thread that calls `connect_and_run`.
/// - `broadcast::Sender` is Send+Sync so frame_tx can be cloned into RustData.
/// - The `AnyscpContext` struct is allocated by FreeRDP via `freerdp_context_new`
///   after we set `ContextSize` to `size_of::<AnyscpContext>()`.  The extra
///   `rust_data` pointer is owned by `FreeRdpClient` and lives at least as long
///   as the C context.
use super::ffi;
use super::types::RdpConfig;
use std::ffi::CString;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

// PIXEL_FORMAT_RGBA32  =  FREERDP_PIXEL_FORMAT(32, TYPE_RGBA=3, a=8, r=8, g=8, b=8)
//  = (32<<24)|(3<<16)|(8<<12)|(8<<8)|(8<<4)|8  =  0x20038888
const PIXEL_FORMAT_RGBA32: ffi::UINT32 = 0x20038888;

// ── Custom extended context ─────────────────────────────────────────────────

/// Extended client context.  The `client_context` MUST be the very first field
/// so that FreeRDP can safely cast `*mut rdpClientContext` ↔ `*mut AnyscpContext`.
#[repr(C)]
struct AnyscpContext {
    client_context: ffi::rdpClientContext,
    rust_data: *mut RustData,
}

struct RustData {
    frame_tx: broadcast::Sender<Vec<u8>>,
    width: u16,
    height: u16,
}

// ── Public client struct ────────────────────────────────────────────────────

pub struct FreeRdpClient {
    /// The freerdp instance pointer — owned here.
    instance: *mut ffi::freerdp,
    /// Box to keep RustData alive while the client lives.
    _rust_data: Box<RustData>,
}

// Safety:
// - Send: the instance pointer is only driven by one OS thread at a time.
// - Sync: the send_*_event methods route through freerdp_input_send_* which
//   are documented as thread-safe in FreeRDP 3.x (they queue input atomically).
//   No other mutable state is exposed across threads.
unsafe impl Send for FreeRdpClient {}
unsafe impl Sync for FreeRdpClient {}

// ── C callbacks ────────────────────────────────────────────────────────────

/// Retrieve the RustData pointer from any freerdp context pointer.
///
/// # Safety
/// Caller must guarantee the context was allocated by us with AnyscpContext
/// as the extended type, and that the rust_data pointer is still valid.
unsafe fn rust_data_from_context(context: *mut ffi::rdpContext) -> *mut RustData {
    let anyscp = context as *mut AnyscpContext;
    (*anyscp).rust_data
}

/// Called by FreeRDP after the context allocation; we set all instance
/// callbacks here so that they are in place before `freerdp_connect`.
unsafe extern "C" fn client_new(
    instance: *mut ffi::freerdp,
    _context: *mut ffi::rdpContext,
) -> ffi::BOOL {
    if instance.is_null() {
        return 0;
    }
    (*instance).PreConnect = Some(pre_connect);
    (*instance).PostConnect = Some(post_connect);
    (*instance).PostDisconnect = Some(post_disconnect);
    (*instance).AuthenticateEx = Some(authenticate_ex);
    (*instance).VerifyCertificateEx = Some(verify_certificate_ex);
    1 // TRUE
}

unsafe extern "C" fn client_free(
    _instance: *mut ffi::freerdp,
    _context: *mut ffi::rdpContext,
) {
    // rust_data is owned by FreeRdpClient._rust_data; do not free here.
}

/// PreConnect: configure settings before the TCP connection is established.
unsafe extern "C" fn pre_connect(instance: *mut ffi::freerdp) -> ffi::BOOL {
    if instance.is_null() {
        return 0;
    }
    let context = (*instance).context;
    if context.is_null() {
        return 0;
    }
    let settings = (*context).settings;
    if settings.is_null() {
        return 0;
    }
    let rd = rust_data_from_context(context);
    if rd.is_null() {
        return 0;
    }

    // Keyboard layout: en-US
    ffi::freerdp_settings_set_uint32(
        settings,
        ffi::FreeRDP_Settings_Keys_UInt32_FreeRDP_DesktopWidth,
        (*rd).width as ffi::UINT32,
    );
    ffi::freerdp_settings_set_uint32(
        settings,
        ffi::FreeRDP_Settings_Keys_UInt32_FreeRDP_DesktopHeight,
        (*rd).height as ffi::UINT32,
    );
    ffi::freerdp_settings_set_uint32(
        settings,
        ffi::FreeRDP_Settings_Keys_UInt32_FreeRDP_ColorDepth,
        32,
    );

    // Disable audio, RemoteApp, etc.
    ffi::freerdp_settings_set_bool(
        settings,
        ffi::FreeRDP_Settings_Keys_Bool_FreeRDP_RemoteApplicationMode,
        0,
    );

    // Performance flags: disable eye-candy for speed
    ffi::freerdp_settings_set_uint32(
        settings,
        ffi::FreeRDP_Settings_Keys_UInt32_FreeRDP_PerformanceFlags,
        0x0028, // PERF_DISABLE_WALLPAPER | PERF_DISABLE_FULLWINDOWDRAG
    );

    // Enable GFX pipeline (H.264 / RemoteFX successor) if available
    ffi::freerdp_settings_set_bool(
        settings,
        ffi::FreeRDP_Settings_Keys_Bool_FreeRDP_SupportGraphicsPipeline,
        1,
    );
    // Disable H.264 inside GFX — we want raw RGB for the simplest path
    ffi::freerdp_settings_set_bool(
        settings,
        ffi::FreeRDP_Settings_Keys_Bool_FreeRDP_GfxH264,
        0,
    );

    // TLS + NLA
    ffi::freerdp_settings_set_bool(
        settings,
        ffi::FreeRDP_Settings_Keys_Bool_FreeRDP_TlsSecurity,
        1,
    );
    ffi::freerdp_settings_set_bool(
        settings,
        ffi::FreeRDP_Settings_Keys_Bool_FreeRDP_NlaSecurity,
        1,
    );

    // Fast path input
    ffi::freerdp_settings_set_bool(
        settings,
        ffi::FreeRDP_Settings_Keys_Bool_FreeRDP_FastPathInput,
        1,
    );

    1 // TRUE
}

/// PostConnect: initialise the GDI layer.
/// We do NOT override BeginPaint/EndPaint — FreeRDP 3.x routes updates
/// through an internal proxy, so direct assignment on rdpUpdate doesn't work.
/// Instead, the event loop polls the GDI framebuffer after each event cycle.
unsafe extern "C" fn post_connect(instance: *mut ffi::freerdp) -> ffi::BOOL {
    if instance.is_null() {
        return 0;
    }
    let context = (*instance).context;
    if context.is_null() {
        return 0;
    }

    // Initialise GDI with RGBA32 pixel format.
    if ffi::gdi_init(instance, PIXEL_FORMAT_RGBA32) == 0 {
        error!("gdi_init failed");
        return 0;
    }

    info!("FreeRDP PostConnect: GDI initialised");
    1 // TRUE
}

unsafe extern "C" fn post_disconnect(instance: *mut ffi::freerdp) {
    if instance.is_null() {
        return;
    }
    info!("FreeRDP PostDisconnect");
}

/// BeginPaint: reset the invalid (dirty) region so EndPaint can accumulate it.
unsafe extern "C" fn begin_paint(context: *mut ffi::rdpContext) -> ffi::BOOL {
    if context.is_null() {
        return 0;
    }
    let gdi = (*context).gdi;
    if gdi.is_null() {
        return 1;
    }
    let hdc = (*gdi).hdc;
    if hdc.is_null() {
        return 1;
    }
    let hwnd = (*hdc).hwnd;
    if hwnd.is_null() {
        return 1;
    }
    let invalid = (*hwnd).invalid;
    if !invalid.is_null() {
        (*invalid).null = 1; // TRUE — mark the invalid region as empty
    }
    1
}

/// EndPaint: read the dirty rectangle from GDI, extract RGBA pixels, and push
/// an 8-byte-header + raw-pixel message over the broadcast channel.
unsafe extern "C" fn end_paint(context: *mut ffi::rdpContext) -> ffi::BOOL {
    // Absolute first log — if this doesn't appear, the callback isn't being called at all
    static mut EP_COUNT: u64 = 0;
    EP_COUNT += 1;
    if EP_COUNT <= 3 {
        eprintln!("[ANYSCP] end_paint called #{EP_COUNT}, context_null={}", context.is_null());
    }

    if context.is_null() {
        return 0;
    }
    let gdi = (*context).gdi;
    if gdi.is_null() {
        if EP_COUNT <= 3 { eprintln!("[ANYSCP] end_paint: gdi is null!"); }
        return 1;
    }

    // --- read dirty region ---
    let hdc = (*gdi).hdc;
    if hdc.is_null() {
        return 1;
    }
    let hwnd = (*hdc).hwnd;
    if hwnd.is_null() {
        return 1;
    }
    let invalid = (*hwnd).invalid;
    if invalid.is_null() {
        return 1;
    }

    // If null==TRUE the region is empty (no update this frame)
    if (*invalid).null != 0 {
        return 1;
    }

    let x = (*invalid).x;
    let y = (*invalid).y;
    let w = (*invalid).w;
    let h = (*invalid).h;

    // Log the first few frames to diagnose blank screen
    static mut FRAME_COUNT: u64 = 0;
    FRAME_COUNT += 1;
    if FRAME_COUNT <= 5 || FRAME_COUNT % 100 == 0 {
        info!("EndPaint #{FRAME_COUNT}: dirty=({x},{y},{w},{h}) gdi_size={}x{} stride={} buf_null={}",
            (*gdi).width, (*gdi).height, (*gdi).bitmap_stride,
            (*gdi).primary_buffer.is_null());
    }

    if w <= 0 || h <= 0 {
        return 1;
    }

    // --- read pixel data ---
    let primary_buffer = (*gdi).primary_buffer;
    if primary_buffer.is_null() {
        return 1;
    }
    let stride = (*gdi).bitmap_stride as usize; // bytes per row of the whole surface
    let gdi_w = (*gdi).width as usize;
    let gdi_h = (*gdi).height as usize;

    // Clamp dirty rect to surface bounds
    let x = x.max(0) as usize;
    let y = y.max(0) as usize;
    let w = (w as usize).min(gdi_w.saturating_sub(x));
    let h = (h as usize).min(gdi_h.saturating_sub(y));

    if w == 0 || h == 0 {
        return 1;
    }

    // --- obtain frame_tx ---
    let rd = rust_data_from_context(context);
    if rd.is_null() {
        return 1;
    }

    // Skip work if nobody is listening
    if (*rd).frame_tx.receiver_count() == 0 {
        return 1;
    }

    // Build: [x:u16 LE][y:u16 LE][w:u16 LE][h:u16 LE] + RGBA rows
    let pixel_bytes = w * h * 4;
    let mut msg: Vec<u8> = Vec::with_capacity(8 + pixel_bytes);
    msg.extend_from_slice(&(x as u16).to_le_bytes());
    msg.extend_from_slice(&(y as u16).to_le_bytes());
    msg.extend_from_slice(&(w as u16).to_le_bytes());
    msg.extend_from_slice(&(h as u16).to_le_bytes());

    // Copy row-by-row from the primary_buffer
    let total_buf_size = stride * gdi_h;
    let buf_slice = std::slice::from_raw_parts(primary_buffer, total_buf_size);
    for row in 0..h {
        let row_start = (y + row) * stride + x * 4;
        let row_end = row_start + w * 4;
        if row_end <= total_buf_size {
            msg.extend_from_slice(&buf_slice[row_start..row_end]);
        }
    }

    let _ = (*rd).frame_tx.send(msg);
    1
}

/// AuthenticateEx: credentials were set in pre_connect; just return TRUE.
unsafe extern "C" fn authenticate_ex(
    _instance: *mut ffi::freerdp,
    _username: *mut *mut std::os::raw::c_char,
    _password: *mut *mut std::os::raw::c_char,
    _domain: *mut *mut std::os::raw::c_char,
    _reason: ffi::rdp_auth_reason,
) -> ffi::BOOL {
    1 // TRUE — credentials already loaded from settings
}

/// VerifyCertificateEx: accept all certificates.
unsafe extern "C" fn verify_certificate_ex(
    _instance: *mut ffi::freerdp,
    _host: *const std::os::raw::c_char,
    _port: ffi::UINT16,
    _common_name: *const std::os::raw::c_char,
    _subject: *const std::os::raw::c_char,
    _issuer: *const std::os::raw::c_char,
    _fingerprint: *const std::os::raw::c_char,
    _flags: ffi::DWORD,
) -> ffi::DWORD {
    2 // 2 = accept for this session only (no persistent storage)
}

// ── FreeRdpClient impl ──────────────────────────────────────────────────────

impl FreeRdpClient {
    /// Create a new FreeRDP client, configure entry points, and set host/auth
    /// settings on the rdpSettings object.
    #[tracing::instrument(skip(config, frame_tx), fields(host = %config.host))]
    pub fn new(
        config: &RdpConfig,
        frame_tx: broadcast::Sender<Vec<u8>>,
    ) -> Result<Self, String> {
        // Allocate the RustData on the heap.  A raw pointer to this is stored
        // inside the C context struct; the Box lives in FreeRdpClient.
        let rust_data = Box::new(RustData {
            frame_tx,
            width: config.width,
            height: config.height,
        });
        let rust_data_ptr = &*rust_data as *const RustData as *mut RustData;

        unsafe {
            // 1. Allocate the freerdp instance.
            let instance = ffi::freerdp_new();
            if instance.is_null() {
                return Err("freerdp_new() returned null".into());
            }

            // 2. Set ContextSize so FreeRDP allocates AnyscpContext (not bare rdpClientContext).
            (*instance).ContextSize = std::mem::size_of::<AnyscpContext>();
            (*instance).ContextNew = Some(client_new);
            (*instance).ContextFree = Some(client_free);

            // 3. Allocate the context (calls client_new).
            if ffi::freerdp_context_new(instance) == 0 {
                ffi::freerdp_free(instance);
                return Err("freerdp_context_new() failed".into());
            }

            let context = (*instance).context;
            if context.is_null() {
                ffi::freerdp_context_free(instance);
                ffi::freerdp_free(instance);
                return Err("context is null after freerdp_context_new".into());
            }

            // 4. Embed rust_data pointer into the extended context area.
            let anyscp = context as *mut AnyscpContext;
            (*anyscp).rust_data = rust_data_ptr;

            // 5. Configure settings.
            let settings = (*context).settings;
            if settings.is_null() {
                ffi::freerdp_context_free(instance);
                ffi::freerdp_free(instance);
                return Err("settings is null".into());
            }

            // Hostname
            let host_c = CString::new(config.host.as_str())
                .map_err(|e| format!("host CString: {e}"))?;
            if ffi::freerdp_settings_set_string(
                settings,
                ffi::FreeRDP_Settings_Keys_String_FreeRDP_ServerHostname,
                host_c.as_ptr(),
            ) == 0
            {
                warn!("failed to set ServerHostname");
            }

            // Port
            ffi::freerdp_settings_set_uint32(
                settings,
                ffi::FreeRDP_Settings_Keys_UInt32_FreeRDP_ServerPort,
                config.port as ffi::UINT32,
            );

            // Username
            let user_c = CString::new(config.username.as_str())
                .map_err(|e| format!("username CString: {e}"))?;
            if ffi::freerdp_settings_set_string(
                settings,
                ffi::FreeRDP_Settings_Keys_String_FreeRDP_Username,
                user_c.as_ptr(),
            ) == 0
            {
                warn!("failed to set Username");
            }

            // Password
            let pass_c = CString::new(config.password.as_str())
                .map_err(|e| format!("password CString: {e}"))?;
            if ffi::freerdp_settings_set_string(
                settings,
                ffi::FreeRDP_Settings_Keys_String_FreeRDP_Password,
                pass_c.as_ptr(),
            ) == 0
            {
                warn!("failed to set Password");
            }

            // Domain (optional)
            if let Some(ref domain) = config.domain {
                let dom_c = CString::new(domain.as_str())
                    .map_err(|e| format!("domain CString: {e}"))?;
                if ffi::freerdp_settings_set_string(
                    settings,
                    ffi::FreeRDP_Settings_Keys_String_FreeRDP_Domain,
                    dom_c.as_ptr(),
                ) == 0
                {
                    warn!("failed to set Domain");
                }
            }

            // Resolution — also set in PreConnect, but good to have them here.
            ffi::freerdp_settings_set_uint32(
                settings,
                ffi::FreeRDP_Settings_Keys_UInt32_FreeRDP_DesktopWidth,
                config.width as ffi::UINT32,
            );
            ffi::freerdp_settings_set_uint32(
                settings,
                ffi::FreeRDP_Settings_Keys_UInt32_FreeRDP_DesktopHeight,
                config.height as ffi::UINT32,
            );

            info!(host = %config.host, port = config.port, "FreeRDP client created");
            Ok(Self {
                instance,
                _rust_data: rust_data,
            })
        }
    }

    /// Drive the FreeRDP event loop without consuming `self`.
    ///
    /// This is used when the client is wrapped in an `Arc` and we cannot take
    /// ownership.  It behaves identically to `connect_and_run` but does NOT
    /// call `freerdp_free` on exit — the `Drop` impl handles cleanup when the
    /// last Arc reference is dropped.
    #[tracing::instrument(skip(self))]
    pub fn run_blocking(&self) -> Result<(), String> {
        unsafe {
            let instance = self.instance;

            if ffi::freerdp_connect(instance) == 0 {
                let context = (*instance).context;
                let err = if !context.is_null() {
                    ffi::freerdp_get_last_error(context)
                } else {
                    0
                };
                return Err(format!("freerdp_connect() failed (error 0x{err:08x})"));
            }

            info!("FreeRDP connected (run_blocking), entering event loop");

            let context = (*instance).context;
            let mut handles: [ffi::HANDLE; 64] = [std::ptr::null_mut(); 64];

            // Get RustData for frame sending
            let rd = rust_data_from_context(context);

            let mut frame_count: u64 = 0;

            loop {
                if ffi::freerdp_shall_disconnect(instance) != 0 {
                    info!("freerdp_shall_disconnect: exiting event loop");
                    break;
                }

                let count = ffi::freerdp_get_event_handles(
                    context,
                    handles.as_mut_ptr(),
                    handles.len() as ffi::DWORD,
                );
                if count == 0 {
                    warn!("freerdp_get_event_handles returned 0");
                    break;
                }

                let status = ffi::WaitForMultipleObjects(
                    count,
                    handles.as_ptr(),
                    0,
                    100,
                );

                if status == 0xFFFF_FFFF {
                    error!("WaitForMultipleObjects failed");
                    break;
                }

                if ffi::freerdp_check_event_handles(context) == 0 {
                    let err = ffi::freerdp_get_last_error(context);
                    if err != 0 {
                        warn!("freerdp_check_event_handles failed: 0x{err:08x}");
                    }
                    break;
                }

                // ── Poll the GDI framebuffer for dirty regions ──────────────
                // FreeRDP 3.x's internal GDI handlers update the framebuffer
                // and mark the invalid region. We read it here instead of in
                // BeginPaint/EndPaint callbacks (which don't fire via proxy).
                let gdi = (*context).gdi;
                if !gdi.is_null() && !(*gdi).primary_buffer.is_null() {
                    let hdc = (*(*gdi).primary).hdc;
                    if !hdc.is_null() {
                        let hwnd = (*hdc).hwnd;
                        if !hwnd.is_null() {
                            let invalid = (*hwnd).invalid;
                            if !invalid.is_null() && (*invalid).null == 0 {
                                let x = (*invalid).x.max(0) as usize;
                                let y = (*invalid).y.max(0) as usize;
                                let gdi_w = (*gdi).width as usize;
                                let gdi_h = (*gdi).height as usize;
                                let w = ((*invalid).w as usize).min(gdi_w.saturating_sub(x));
                                let h = ((*invalid).h as usize).min(gdi_h.saturating_sub(y));

                                if w > 0 && h > 0 && !rd.is_null() && (*rd).frame_tx.receiver_count() > 0 {
                                    let stride = (*gdi).stride as usize;  // use stride, not bitmap_stride
                                    let buf_size = stride * gdi_h;
                                    if frame_count == 0 {
                                        eprintln!("[ANYSCP] GDI: stride={stride} bitmap_stride={} gdi_w={gdi_w} gdi_h={gdi_h} buf_size={buf_size} primary_buffer={:?}",
                                            (*gdi).bitmap_stride, (*gdi).primary_buffer);
                                    }
                                    let buf = std::slice::from_raw_parts((*gdi).primary_buffer, buf_size);

                                    let pixel_bytes = w * h * 4;
                                    let mut msg = Vec::with_capacity(8 + pixel_bytes);
                                    msg.extend_from_slice(&(x as u16).to_le_bytes());
                                    msg.extend_from_slice(&(y as u16).to_le_bytes());
                                    msg.extend_from_slice(&(w as u16).to_le_bytes());
                                    msg.extend_from_slice(&(h as u16).to_le_bytes());

                                    for row in 0..h {
                                        let rs = (y + row) * stride + x * 4;
                                        let re = rs + w * 4;
                                        if re <= buf_size {
                                            msg.extend_from_slice(&buf[rs..re]);
                                        }
                                    }

                                    let receivers = (*rd).frame_tx.receiver_count();
                                    let msg_len = msg.len();
                                    let send_result = (*rd).frame_tx.send(msg);

                                    frame_count += 1;
                                    if frame_count <= 5 || frame_count % 100 == 0 {
                                        info!("Frame #{frame_count}: dirty=({x},{y},{w},{h}) msg_bytes={msg_len} receivers={receivers} send_ok={}", send_result.is_ok());
                                    }
                                }

                                // Do NOT reset invalid region here — let GDI's
                                // internal begin_paint handle it on the next frame.
                            }
                        }
                    }
                }
            }

            ffi::freerdp_disconnect(instance);
        }
        info!("FreeRDP run_blocking event loop exited");
        Ok(())
    }

    /// Send a keyboard event.  Thread-safe: FreeRDP queues input internally.
    pub fn send_key_event(&self, scancode: u8, extended: bool, pressed: bool) {
        unsafe {
            let context = (*self.instance).context;
            if context.is_null() {
                return;
            }
            let input = (*context).input;
            if input.is_null() {
                return;
            }
            // Key press = 0, Key release = KBD_FLAGS_RELEASE (0x8000)
            // KBD_FLAGS_DOWN (0x4000) means auto-repeat, NOT initial press
            let mut flags: ffi::UINT16 = if pressed {
                0
            } else {
                ffi::KBD_FLAGS_RELEASE as ffi::UINT16
            };
            if extended {
                flags |= ffi::KBD_FLAGS_EXTENDED as ffi::UINT16;
            }
            ffi::freerdp_input_send_keyboard_event(input, flags, scancode);
        }
    }

    /// Send a mouse event.  Thread-safe.
    pub fn send_mouse_event(&self, flags: u16, x: u16, y: u16) {
        unsafe {
            let context = (*self.instance).context;
            if context.is_null() {
                return;
            }
            let input = (*context).input;
            if input.is_null() {
                return;
            }
            ffi::freerdp_input_send_mouse_event(input, flags, x, y);
        }
    }
}

impl Drop for FreeRdpClient {
    fn drop(&mut self) {
        // Only reached when the client is dropped WITHOUT calling connect_and_run
        // (which calls mem::forget(self) to prevent double-free).
        unsafe {
            let instance = self.instance;
            if !instance.is_null() {
                let context = (*instance).context;
                if !context.is_null() {
                    ffi::freerdp_context_free(instance);
                }
                ffi::freerdp_free(instance);
            }
        }
    }
}
