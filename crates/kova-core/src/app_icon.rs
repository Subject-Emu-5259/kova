//! Locating a macOS `.app` bundle's icon file.
//!
//! This helper is intentionally pure file-system inspection: it does
//! not decode or convert the icon, and it works in headless tests on
//! any OS. The Tauri backend uses it on macOS, then either copies a
//! PNG/JPG result or asks macOS `sips` to convert an `.icns` file.
//!
//! Lookup order inside `Contents/Resources`:
//!
//! 1. The icon declared by `CFBundleIconFile` in
//!    `Contents/Info.plist` (the value may or may not carry the
//!    `.icns` extension, and may name a PNG/JPG resource instead).
//! 2. The conventional names `AppIcon.icns`, `icon.icns`, and
//!    `Icon.icns`.
//! 3. Any other `.icns` file, choosing the largest file and breaking
//!    ties by path so repeated scans are deterministic.
//! 4. Any PNG/JPG/JPEG resource, again largest first with a
//!    deterministic path tie-break.

use std::fs;
use std::path::{Path, PathBuf};

fn extension_lower(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_lowercase())
}

fn is_image_path(path: &Path) -> bool {
    matches!(
        extension_lower(path).as_deref(),
        Some("icns") | Some("png") | Some("jpg") | Some("jpeg")
    )
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Pick the largest existing file, breaking size ties by the
/// lexicographically smallest path. This keeps the result stable
/// across file-system enumeration orders.
fn largest_deterministic(mut paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths.retain(|p| p.is_file());
    paths.sort_by(|a, b| {
        file_len(b)
            .cmp(&file_len(a))
            .then_with(|| a.as_os_str().cmp(b.as_os_str()))
    });
    paths.into_iter().next()
}

/// Decode the small set of XML entities that can realistically occur
/// in an icon file name inside an XML `Info.plist`.
fn decode_xml_entities(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Extract the `CFBundleIconFile` string from an XML/text plist.
///
/// Binary plists are deliberately not decoded by kova-core; callers
/// still get the conventional-name fallback in [`locate_app_icon`].
/// The parser is tolerant of whitespace and comments between the key
/// and its string value.
pub fn declared_icon_file(info_plist_contents: &str) -> Option<String> {
    let key = "<key>CFBundleIconFile</key>";
    let after_key = info_plist_contents.split(key).nth(1)?;
    let string_start = after_key.find("<string>")? + "<string>".len();
    let string_end = after_key[string_start..].find("</string>")? + string_start;
    let value = decode_xml_entities(after_key[string_start..string_end].trim());
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn declared_icon_candidates(resources: &Path, declared: &str) -> Vec<PathBuf> {
    // Plist values are normally a bare resource name. If a bundle
    // nevertheless stores a path, only its final component belongs
    // under Contents/Resources.
    let file_name = Path::new(declared)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| declared.to_string());
    let declared_path = resources.join(&file_name);

    if is_image_path(&declared_path) {
        return vec![declared_path];
    }

    // A value without an image extension most often means the same
    // name with `.icns`; PNG/JPG spellings are accepted too.
    let mut out = vec![declared_path];
    for ext in ["icns", "png", "jpg", "jpeg"] {
        out.push(resources.join(format!("{file_name}.{ext}")));
    }
    out
}

/// Locate the best icon resource inside a macOS `.app` bundle.
///
/// Returns `None` for a missing/non-bundle path or a bundle whose
/// `Contents/Resources` has no usable icon. This function never
/// follows the bundle outside its own `Contents` directory.
pub fn locate_app_icon(bundle: &Path) -> Option<PathBuf> {
    if !bundle.is_dir()
        || bundle
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            != Some("app".to_string())
    {
        return None;
    }

    let contents = bundle.join("Contents");
    let resources = contents.join("Resources");
    if !resources.is_dir() {
        return None;
    }

    // 1. The bundle's declared icon wins when it exists.
    let info_plist = contents.join("Info.plist");
    if let Ok(text) = fs::read_to_string(&info_plist) {
        if let Some(declared) = declared_icon_file(&text) {
            for candidate in declared_icon_candidates(&resources, &declared) {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    // 2. Conventional .icns names, in the established order.
    for name in ["AppIcon.icns", "icon.icns", "Icon.icns"] {
        let candidate = resources.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // 3. Any other .icns resource. If several exist, the largest is
    // normally the full-resolution icon set; paths settle ties.
    let mut icns_files = Vec::new();
    let mut image_files = Vec::new();
    if let Ok(entries) = fs::read_dir(&resources) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            match extension_lower(&path).as_deref() {
                Some("icns") => icns_files.push(path),
                Some("png") | Some("jpg") | Some("jpeg") => image_files.push(path),
                _ => {}
            }
        }
    }
    if let Some(icon) = largest_deterministic(icns_files) {
        return Some(icon);
    }

    // 4. A bundle that ships only raster art is still usable.
    largest_deterministic(image_files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

    struct Fixture {
        root: PathBuf,
        bundle: PathBuf,
        resources: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("kova-app-icon-{}-{label}-{id}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            let bundle = root.join("Example.app");
            let resources = bundle.join("Contents").join("Resources");
            fs::create_dir_all(&resources).unwrap();
            Self {
                root,
                bundle,
                resources,
            }
        }

        fn write_info(&self, icon_value: Option<&str>) {
            let icon = icon_value
                .map(|value| format!("\n<key>CFBundleIconFile</key>\n<string>{value}</string>"))
                .unwrap_or_default();
            fs::write(
                self.bundle.join("Contents").join("Info.plist"),
                format!("<?xml version=\"1.0\"?>\n<plist><dict>{icon}\n</dict></plist>"),
            )
            .unwrap();
        }

        fn write_resource(&self, name: &str, bytes: usize) -> PathBuf {
            let path = self.resources.join(name);
            fs::write(&path, vec![b'x'; bytes]).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn declared_icon_without_extension_finds_icns() {
        let fixture = Fixture::new("declared-no-ext");
        fixture.write_info(Some("HeroIcon"));
        let expected = fixture.write_resource("HeroIcon.icns", 10);
        fixture.write_resource("AppIcon.icns", 100);
        assert_eq!(locate_app_icon(&fixture.bundle), Some(expected));
    }

    #[test]
    fn declared_icon_with_icns_extension_is_used_verbatim() {
        let fixture = Fixture::new("declared-with-ext");
        fixture.write_info(Some("HeroIcon.icns"));
        let expected = fixture.write_resource("HeroIcon.icns", 10);
        fixture.write_resource("AppIcon.icns", 100);
        assert_eq!(locate_app_icon(&fixture.bundle), Some(expected));
    }

    #[test]
    fn declared_png_icon_is_accepted() {
        let fixture = Fixture::new("declared-png");
        fixture.write_info(Some("HeroIcon.png"));
        let expected = fixture.write_resource("HeroIcon.png", 10);
        fixture.write_resource("AppIcon.icns", 100);
        assert_eq!(locate_app_icon(&fixture.bundle), Some(expected));
    }

    #[test]
    fn conventional_icon_wins_without_a_declaration() {
        let fixture = Fixture::new("conventional");
        fixture.write_info(None);
        let expected = fixture.write_resource("AppIcon.icns", 5);
        fixture.write_resource("Random.icns", 100);
        assert_eq!(locate_app_icon(&fixture.bundle), Some(expected));
    }

    #[test]
    fn largest_icns_wins_and_ties_are_deterministic() {
        let fixture = Fixture::new("largest-icns");
        fixture.write_info(Some("MissingIcon"));
        fixture.write_resource("Aardvark.icns", 20);
        fixture.write_resource("Zebra.icns", 30);
        let expected = fixture.write_resource("Middle.icns", 30);
        // Zebra and Middle tie on size after sorting candidates by
        // descending size and ascending path: Middle sorts first.
        assert_eq!(locate_app_icon(&fixture.bundle), Some(expected));
    }

    #[test]
    fn raster_only_bundle_falls_back_to_largest_image() {
        let fixture = Fixture::new("raster-fallback");
        fixture.write_info(None);
        fixture.write_resource("small.png", 4);
        let expected = fixture.write_resource("large.jpg", 40);
        assert_eq!(locate_app_icon(&fixture.bundle), Some(expected));
    }

    #[test]
    fn missing_bundle_or_icon_returns_none() {
        let fixture = Fixture::new("missing-icon");
        fixture.write_info(None);
        assert_eq!(locate_app_icon(&fixture.bundle), None);
        assert_eq!(locate_app_icon(&fixture.root.join("Nope.app")), None);
    }
}
