use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::config::update_temp_root;

const TARGET_EXE_NAME: &str = "OpenXLauncher.exe";
const OLD_EXE_NAME: &str = "OpenXLauncher_old.exe";
const ACK_TIMEOUT_SECONDS: u32 = 120;

/// Resolve the portable executable to copy (plain `.exe` or extracted from `.zip`).
pub fn resolve_portable_exe_source(download_path: &Path) -> Result<PathBuf, String> {
    let ext = download_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "exe" {
        return Ok(download_path.to_path_buf());
    }

    if ext == "zip" {
        let extract_dir = update_temp_root().join("extract");
        let _ = fs::remove_dir_all(&extract_dir);
        fs::create_dir_all(&extract_dir).map_err(|e| format!("创建解压目录失败: {}", e))?;
        extract_zip_portable(download_path, &extract_dir)?;
        return find_openx_exe_in_dir(&extract_dir);
    }

    Err(format!(
        "不支持的更新包格式: {}（需要 .exe 或 .zip）",
        download_path.display()
    ))
}

fn extract_zip_portable(source: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let canonical_dest = dest
        .canonicalize()
        .or_else(|_| {
            fs::create_dir_all(dest).ok();
            dest.canonicalize()
        })
        .map_err(|e| format!("无法解析目标目录: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let safe_rel_path = file
            .enclosed_name()
            .ok_or_else(|| format!("非法的 zip 条目路径: {}", file.name()))?;
        if safe_rel_path.is_absolute() {
            return Err(format!("拒绝解压绝对路径条目: {}", file.name()));
        }
        if safe_rel_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("拒绝解压包含上级目录引用的条目: {}", file.name()));
        }
        let outpath = canonical_dest.join(&safe_rel_path);
        if file.is_dir() {
            fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn find_openx_exe_in_dir(dir: &Path) -> Result<PathBuf, String> {
    fn walk(dir: &Path) -> Option<PathBuf> {
        let entries = fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = walk(&path) {
                    return Some(found);
                }
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case(TARGET_EXE_NAME))
                .unwrap_or(false)
            {
                return Some(path);
            }
        }
        None
    }
    walk(dir).ok_or_else(|| format!("在更新包中未找到 {}", TARGET_EXE_NAME))
}

pub fn build_replace_batch_script(
    install_dir: &Path,
    new_exe_source: &Path,
    ack_path: &Path,
    fail_notice_template: &Path,
    fail_notice_flag: &Path,
) -> String {
    let install = install_dir.to_string_lossy().replace('%', "%%");
    let new_src = new_exe_source.to_string_lossy().replace('%', "%%");
    let ack = ack_path.to_string_lossy().replace('%', "%%");
    let fail_tpl = fail_notice_template.to_string_lossy().replace('%', "%%");
    let fail_flag = fail_notice_flag.to_string_lossy().replace('%', "%%");

    format!(
        "@echo off\r\n\
chcp 65001 >nul\r\n\
setlocal EnableExtensions\r\n\
set \"INSTALL_DIR={install}\"\r\n\
set \"TARGET=%INSTALL_DIR%\\{target_exe}\"\r\n\
set \"OLD=%INSTALL_DIR%\\{old_exe}\"\r\n\
set \"NEW_SRC={new_src}\"\r\n\
set \"ACK={ack}\"\r\n\
set \"FAIL_TPL={fail_tpl}\"\r\n\
set \"FAIL_FLAG={fail_flag}\"\r\n\
\r\n\
timeout /t 3 /nobreak >nul\r\n\
\r\n\
if exist \"%OLD%\" del /f /q \"%OLD%\"\r\n\
\r\n\
set /a REN_TRIES=0\r\n\
:try_rename\r\n\
if not exist \"%TARGET%\" (\r\n\
  echo Target executable missing\r\n\
  goto rollback\r\n\
)\r\n\
ren \"%TARGET%\" \"{old_exe}\"\r\n\
if %errorlevel% equ 0 goto copied\r\n\
set /a REN_TRIES+=1\r\n\
if %REN_TRIES% geq 30 goto rollback\r\n\
timeout /t 1 /nobreak >nul\r\n\
goto try_rename\r\n\
\r\n\
:copied\r\n\
copy /y \"%NEW_SRC%\" \"%TARGET%\"\r\n\
if %errorlevel% neq 0 goto rollback\r\n\
\r\n\
start \"\" \"%TARGET%\" --openx-update-ack=\"%ACK%\"\r\n\
\r\n\
set /a WAIT=0\r\n\
:wait_ack\r\n\
if exist \"%ACK%\" goto success\r\n\
set /a WAIT+=1\r\n\
if %WAIT% geq {ack_timeout} goto rollback\r\n\
timeout /t 1 /nobreak >nul\r\n\
goto wait_ack\r\n\
\r\n\
:success\r\n\
if exist \"%OLD%\" del /f /q \"%OLD%\"\r\n\
del /f /q \"%~f0\" 2>nul\r\n\
exit /b 0\r\n\
\r\n\
:rollback\r\n\
taskkill /IM {target_exe} /F >nul 2>&1\r\n\
if exist \"%TARGET%\" del /f /q \"%TARGET%\"\r\n\
if exist \"%OLD%\" ren \"%OLD%\" \"{target_exe}\"\r\n\
if exist \"%FAIL_TPL%\" copy /y \"%FAIL_TPL%\" \"%FAIL_FLAG%\" >nul\r\n\
if exist \"%TARGET%\" start \"\" \"%TARGET%\" --openx-update-fail=\"%FAIL_FLAG%\"\r\n\
del /f /q \"%~f0\" 2>nul\r\n\
exit /b 1\r\n",
        install = install,
        target_exe = TARGET_EXE_NAME,
        old_exe = OLD_EXE_NAME,
        new_src = new_src,
        ack = ack,
        fail_tpl = fail_tpl,
        fail_flag = fail_flag,
        ack_timeout = ACK_TIMEOUT_SECONDS,
    )
}

pub fn launch_windows_replace(download_path: &Path) -> Result<(), String> {
    let new_exe = resolve_portable_exe_source(download_path)?;

    let current_exe = std::env::current_exe().map_err(|e| format!("无法获取当前程序路径: {}", e))?;
    let install_dir = current_exe
        .parent()
        .ok_or_else(|| "无法获取安装目录".to_string())?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let ack_path = update_temp_root().join(format!("update_ack_{}.flag", timestamp));
    let fail_notice_path = update_temp_root().join(format!("update_fail_template_{}.txt", timestamp));
    let fail_notice_flag = update_temp_root().join(format!("update_fail_notice_{}.flag", timestamp));
    let script_path = update_temp_root().join(format!("replace_{}.bat", timestamp));
    fs::create_dir_all(update_temp_root()).map_err(|e| format!("创建临时目录失败: {}", e))?;

    let fail_message = super::config::read_ui_language()
        .eq_ignore_ascii_case("en-US")
        .then_some("Update failed. The previous version has been restored.")
        .unwrap_or("更新失败，已恢复旧版本。");
    fs::write(&fail_notice_path, fail_message).map_err(|e| format!("写入更新失败说明失败: {}", e))?;

    let script = build_replace_batch_script(
        install_dir,
        &new_exe,
        &ack_path,
        &fail_notice_path,
        &fail_notice_flag,
    );
    fs::write(&script_path, script).map_err(|e| format!("写入替换脚本失败: {}", e))?;
    let _ = crate::handler::runtime_log::append_runtime_log(
        "info",
        "updater",
        "已写入 Windows 替换脚本，即将重启安装",
        Some(serde_json::json!({
            "script": script_path.to_string_lossy(),
            "newExe": new_exe.to_string_lossy(),
            "installDir": install_dir.to_string_lossy(),
        })),
    );

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use winapi::um::winbase::CREATE_NO_WINDOW;
        std::process::Command::new("cmd")
            .args(["/C", script_path.to_string_lossy().as_ref()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("启动替换脚本失败: {}", e))?;
    }

    #[cfg(not(windows))]
    {
        return Err("Windows replace script can only run on Windows".to_string());
    }

    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_script_contains_old_rename_and_ack_flag() {
        let script = build_replace_batch_script(
            Path::new(r"C:\Games\OpenX"),
            Path::new(r"C:\Temp\OpenXLauncher\updates\new.exe"),
            Path::new(r"C:\Temp\OpenXLauncher\ack.flag"),
            Path::new(r"C:\Temp\OpenXLauncher\fail.txt"),
            Path::new(r"C:\Temp\OpenXLauncher\fail.flag"),
        );
        assert!(script.contains("OpenXLauncher_old.exe"));
        assert!(script.contains("--openx-update-ack="));
        assert!(script.contains("--openx-update-fail="));
        assert!(script.contains(":rollback"));
        assert!(!script.contains("MessageBox"));
    }
}
