use std::fs;
use std::path::Path;

fn read_package_json_version(manifest_dir: &str) -> String {
    let path = Path::new(manifest_dir).join("../package.json");
    let content = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    for line in content.lines() {
        let line = line.trim();
        if !line.starts_with("\"version\"") {
            continue;
        }
        let rest = line
            .split_once(':')
            .map(|(_, v)| v.trim().trim_end_matches(',').trim())
            .unwrap_or("");
        let version = rest.trim_matches('"');
        if !version.is_empty() {
            return version.to_string();
        }
    }
    panic!("package.json at {} has no \"version\" field", path.display());
}

fn rerun_if_icons_changed(manifest_dir: &str) {
    let icons_dir = Path::new(manifest_dir).join("icons");
    let stamp = Path::new(manifest_dir).join(".icon-sync-stamp");
    println!("cargo:rerun-if-changed={}", stamp.display());
    for name in [
        "icon.ico",
        "icon.png",
        "32x32.png",
        "64x64.png",
        "128x128.png",
        "128x128@2x.png",
    ] {
        let p = icons_dir.join(name);
        if p.exists() {
            println!("cargo:rerun-if-changed={}", p.display());
        }
    }
}

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    rerun_if_icons_changed(&manifest_dir);
    let version = read_package_json_version(&manifest_dir);
    println!("cargo:rustc-env=LAUNCHER_VERSION={}", version);
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-env-changed=OPENX_PORTABLE_BUILD");

    let portable = std::env::var("OPENX_PORTABLE_BUILD").ok().as_deref() == Some("1");
    if portable {
        println!("cargo:rustc-cfg=openx_portable_build");
    } else {
        let uuid = uuid::Uuid::new_v4().to_string();
        let uuid_path = Path::new(&manifest_dir).join(".build-uuid");
        let _ = fs::write(&uuid_path, &uuid);
        println!("cargo:rustc-env=BUILD_UUID={}", uuid);
        println!("cargo:rerun-if-changed={}", uuid_path.display());
    }

    tauri_build::build()
}
