//! Desktop notifications for agent activity that needs the reader (#244).
//!
//! Core (the page) detects, dedupes and batches the events and words the
//! notifications; the shell only takes them and delivers them. Once a second
//! it calls `window.__mdrTakeAgentNotifications({ focused, permission })`,
//! which answers whether the setting is on and hands over what is ripe. A
//! click comes back as an open of that file at that thread (or of the review)
//! through the same path as any other open (`open_target`).
//!
//! macOS only, through UNUserNotificationCenter, and only when running from a
//! `.app` bundle: the center throws for a bare binary (`cargo run`), so a dev
//! run leaves the feature off. Windows and Linux never set
//! `window.__mdrDesktopNotifications`, so core hides the setting there.

use serde_json::Value;

/// Where a click on a notification goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClickTarget {
    /// A file, and the thread in it when there is one.
    Thread { file: String, comment: Option<String> },
    /// A review session id.
    Review(String),
}

/// One notification as core worded it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub body: String,
    pub group: String,
    pub target: ClickTarget,
}

/// What one take returned.
#[derive(Debug, PartialEq, Eq)]
pub struct Take {
    pub enabled: bool,
    pub items: Vec<Item>,
}

/// The permission the shell reports back to core, which shows a hint in
/// Settings when the system has notifications for mdr turned off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Unknown,
    Granted,
    Denied,
}

impl Permission {
    fn as_str(self) -> &'static str {
        match self {
            Permission::Unknown => "unknown",
            Permission::Granted => "granted",
            Permission::Denied => "denied",
        }
    }
}

/// The eval'd take call: null when the app is not loaded (loading or error
/// page) or predates the hook.
pub fn take_script(focused: bool, permission: Permission) -> String {
    format!(
        "window.__mdrTakeAgentNotifications ? window.__mdrTakeAgentNotifications({{focused: {focused}, permission: \"{}\"}}) : null",
        permission.as_str()
    )
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn parse_target(v: &Value) -> Option<ClickTarget> {
    if let Some(review) = str_field(v, "review").filter(|s| !s.is_empty()) {
        return Some(ClickTarget::Review(review));
    }
    let file = str_field(v, "file").filter(|s| !s.is_empty())?;
    let comment = str_field(v, "commentId").filter(|s| !s.is_empty());
    Some(ClickTarget::Thread { file, comment })
}

/// Parses what the take call returned (its JSON, as eval_with_callback hands
/// it over). None for null or anything malformed; items that do not parse
/// are skipped.
pub fn parse_take(json: &str) -> Option<Take> {
    let v: Value = serde_json::from_str(json).ok()?;
    let enabled = v.get("enabled")?.as_bool()?;
    let items = v
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(Item {
                        id: str_field(item, "id")?,
                        title: str_field(item, "title")?,
                        body: str_field(item, "body").unwrap_or_default(),
                        group: str_field(item, "group").unwrap_or_default(),
                        target: parse_target(item.get("target")?)?,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Take { enabled, items })
}

/// The click target as stored in the notification's userInfo, so a click
/// still lands after mdr was quit and relaunched in between.
pub fn target_to_json(target: &ClickTarget) -> String {
    let v = match target {
        ClickTarget::Thread { file, comment: Some(comment) } => {
            serde_json::json!({ "file": file, "commentId": comment })
        }
        ClickTarget::Thread { file, comment: None } => serde_json::json!({ "file": file }),
        ClickTarget::Review(id) => serde_json::json!({ "review": id }),
    };
    v.to_string()
}

pub fn target_from_json(json: &str) -> Option<ClickTarget> {
    parse_target(&serde_json::from_str::<Value>(json).ok()?)
}

#[cfg(target_os = "macos")]
pub mod mac {
    use super::{target_from_json, target_to_json, ClickTarget, Item, Permission};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, sel, AllocAnyThread};
    use objc2_foundation::{NSBundle, NSDictionary, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::OnceLock;

    const USER_INFO_TARGET: &str = "target";

    /// What a click does with its target; set once by `install`.
    static ON_CLICK: OnceLock<Box<dyn Fn(ClickTarget) + Send + Sync>> = OnceLock::new();
    /// Whether the reader is looking at the window right now; set once by
    /// `install`.
    static READER_PRESENT: OnceLock<Box<dyn Fn() -> bool + Send + Sync>> = OnceLock::new();

    /// 0 unknown, 1 granted, 2 denied.
    static PERMISSION: AtomicU8 = AtomicU8::new(0);
    /// The system prompt is asked for at most once per launch: a prompt
    /// closed without an answer leaves the status undetermined, and asking
    /// again every few seconds would nag.
    static ASKED: AtomicBool = AtomicBool::new(false);

    pub fn permission() -> Permission {
        match PERMISSION.load(Ordering::SeqCst) {
            1 => Permission::Granted,
            2 => Permission::Denied,
            _ => Permission::Unknown,
        }
    }

    fn set_permission(p: Permission) {
        let v = match p {
            Permission::Unknown => 0,
            Permission::Granted => 1,
            Permission::Denied => 2,
        };
        PERMISSION.store(v, Ordering::SeqCst);
    }

    /// Whether notifications can work here: a `.app` bundle with a bundle
    /// id. `currentNotificationCenter` raises an Objective-C exception for a
    /// bare binary, which would abort the app.
    pub fn supported() -> bool {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "MdrNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            /// The app is frontmost. With its window hidden (closed with
            /// Cmd-W) the reader is away from it: show the notification as
            /// usual. With the window focused they came back between the
            /// post and now: show nothing.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                let present = READER_PRESENT.get().is_some_and(|f| f());
                handler.call((if present {
                    UNNotificationPresentationOptions(0)
                } else {
                    UNNotificationPresentationOptions::Banner
                        | UNNotificationPresentationOptions::List
                        | UNNotificationPresentationOptions::Sound
                },));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let info = response.notification().request().content().userInfo();
                let key = NSString::from_str(USER_INFO_TARGET);
                let target = info
                    .objectForKey(&key)
                    .and_then(|v| v.downcast::<NSString>().ok())
                    .and_then(|s| target_from_json(&s.to_string()));
                if let (Some(target), Some(on_click)) = (target, ON_CLICK.get()) {
                    on_click(target);
                }
                handler.call(());
            }
        }
    );

    /// Sets the delegate (clicks, and banners while the app is frontmost).
    /// Called in `setup`, before launch finishes, so a click that launched
    /// the app is still delivered.
    pub fn install(
        reader_present: impl Fn() -> bool + Send + Sync + 'static,
        on_click: impl Fn(ClickTarget) + Send + Sync + 'static,
    ) {
        let _ = READER_PRESENT.set(Box::new(reader_present));
        let _ = ON_CLICK.set(Box::new(on_click));
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly; this one lives for the app.
        std::mem::forget(delegate);
    }

    /// Reads the current authorization; when it has never been asked, asks
    /// (the system prompt, once per launch), then records the answer.
    pub fn refresh_permission(ask_if_undetermined: bool) {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            if status == UNAuthorizationStatus::NotDetermined {
                set_permission(Permission::Unknown);
                if ask_if_undetermined && !ASKED.swap(true, Ordering::SeqCst) {
                    request_permission();
                }
            } else if status == UNAuthorizationStatus::Denied {
                set_permission(Permission::Denied);
            } else {
                set_permission(Permission::Granted);
            }
        });
        center.getNotificationSettingsWithCompletionHandler(&block);
    }

    fn request_permission() {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let block = RcBlock::new(|granted: objc2::runtime::Bool, err: *mut NSError| {
            if let Some(err) = unsafe { err.as_ref() } {
                eprintln!("mdr: notifications not allowed: {}", err.localizedDescription());
            }
            set_permission(if granted.as_bool() { Permission::Granted } else { Permission::Denied });
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &block,
        );
    }

    /// Posts one notification. Dropped when the reader has not allowed them.
    pub fn post(item: &Item) {
        if permission() != Permission::Granted {
            return;
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&item.title));
        content.setBody(&NSString::from_str(&item.body));
        if !item.group.is_empty() {
            content.setThreadIdentifier(&NSString::from_str(&item.group));
        }
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let key = NSString::from_str(USER_INFO_TARGET);
        let value = NSString::from_str(&target_to_json(&item.target));
        let info = NSDictionary::<NSString, NSString>::from_slices(&[&*key], &[&*value]);
        // SAFETY: a dictionary of strings is a valid property-list userInfo.
        unsafe { content.setUserInfo(Retained::cast_unchecked::<NSDictionary>(info).as_ref()) };
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&item.id),
            &content,
            None,
        );
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, None);
    }

    /// Whether WebKit may suspend the page while the window is hidden. It
    /// does after about four minutes hidden (measured: timers, fetches and
    /// SSE all stop until the window shows again), which would stall
    /// detection, so while notifications are on the page is only throttled.
    /// `webview` is the WKWebView (PlatformWebview::inner). macOS 14+; older
    /// systems keep the default.
    ///
    /// # Safety
    /// `webview` must point at a live WKWebView, on the main thread.
    pub unsafe fn set_keep_alive(webview: *mut std::ffi::c_void, keep_alive: bool) {
        use objc2_web_kit::{WKInactiveSchedulingPolicy, WKWebView};
        let Some(view) = (webview as *mut WKWebView).as_ref() else { return };
        let prefs = view.configuration().preferences();
        if !prefs.respondsToSelector(sel!(setInactiveSchedulingPolicy:)) {
            return;
        }
        prefs.setInactiveSchedulingPolicy(if keep_alive {
            WKInactiveSchedulingPolicy::Throttle
        } else {
            WKInactiveSchedulingPolicy::Suspend
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_script_passes_focus_and_permission_and_guards_the_hook() {
        assert_eq!(
            take_script(false, Permission::Granted),
            "window.__mdrTakeAgentNotifications ? window.__mdrTakeAgentNotifications({focused: false, permission: \"granted\"}) : null"
        );
        assert!(take_script(true, Permission::Unknown).contains("focused: true, permission: \"unknown\""));
    }

    #[test]
    fn parse_take_reads_items_and_skips_broken_ones() {
        let json = r#"{"enabled":true,"items":[
            {"id":"r:1","title":"Claude replied on spec.md","body":"Done","group":"/d/spec.md","target":{"file":"/d/spec.md","commentId":"c1"}},
            {"id":"f:rev:1","title":"Claude finished reviewing","body":"a.md","group":"review:rev","target":{"review":"rev"}},
            {"id":"bad","title":"no target"},
            {"title":"no id","target":{"file":"/x.md"}}
        ]}"#;
        let take = parse_take(json).unwrap();
        assert!(take.enabled);
        assert_eq!(
            take.items,
            vec![
                Item {
                    id: "r:1".into(),
                    title: "Claude replied on spec.md".into(),
                    body: "Done".into(),
                    group: "/d/spec.md".into(),
                    target: ClickTarget::Thread { file: "/d/spec.md".into(), comment: Some("c1".into()) },
                },
                Item {
                    id: "f:rev:1".into(),
                    title: "Claude finished reviewing".into(),
                    body: "a.md".into(),
                    group: "review:rev".into(),
                    target: ClickTarget::Review("rev".into()),
                },
            ]
        );
    }

    #[test]
    fn parse_take_rejects_null_and_junk() {
        assert_eq!(parse_take("null"), None);
        assert_eq!(parse_take("not json"), None);
        assert_eq!(parse_take(r#"{"items":[]}"#), None);
        assert_eq!(parse_take(r#"{"enabled":false}"#), Some(Take { enabled: false, items: vec![] }));
    }

    #[test]
    fn click_targets_round_trip_through_user_info() {
        for target in [
            ClickTarget::Thread { file: "/d/a \"b\".md".into(), comment: Some("c1".into()) },
            ClickTarget::Thread { file: "/d/a.md".into(), comment: None },
            ClickTarget::Review("rev_1".into()),
        ] {
            assert_eq!(target_from_json(&target_to_json(&target)), Some(target));
        }
        assert_eq!(target_from_json(r#"{"file":""}"#), None);
        assert_eq!(target_from_json("[]"), None);
    }
}
