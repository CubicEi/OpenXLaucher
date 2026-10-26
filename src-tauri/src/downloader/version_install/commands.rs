//! Tauri commands for version-install sessions.

use tauri::AppHandle;

use crate::downloader::dwPatch::get_minecraft_dir;

use super::events::LegacyEventFamily;
use super::java_check::{check_java_for_mc, require_java_or_err, JavaCheckResult};
use super::orchestrator::spawn_session;
use super::plan::{
    InstallPlan, LoaderSelection, VersionInstallPlanInput,
};
use super::session::{
    build_session, cancel_session_by_id, cancel_session_by_task_id, VersionInstallSessionStart,
};

#[tauri::command]
pub async fn check_java_for_mc_version(
    mcVersion: String,
    needsJava: Option<bool>,
) -> Result<JavaCheckResult, String> {
    Ok(check_java_for_mc(&mcVersion, needsJava.unwrap_or(true)))
}

#[tauri::command]
pub async fn start_version_install_session(
    app: AppHandle,
    plan: VersionInstallPlanInput,
) -> Result<VersionInstallSessionStart, String> {
    let resolved = InstallPlan::from_input(plan)?;
    start_with_plan(
        app,
        resolved.plan,
        resolved.retarget_source_instance,
        LegacyEventFamily::None,
    )
    .await
}

#[tauri::command]
pub async fn cancel_version_install_session(sessionId: String) -> Result<(), String> {
    cancel_session_by_id(&sessionId)
}

/// Cancel by either download or install task id (also used by legacy cancel shims).
pub fn cancel_by_task_id(task_id: u64) -> Result<(), String> {
    cancel_session_by_task_id(task_id)
}

async fn start_with_plan(
    app: AppHandle,
    plan: InstallPlan,
    retarget_source_instance: Option<String>,
    legacy: LegacyEventFamily,
) -> Result<VersionInstallSessionStart, String> {
    let java_path = if plan.needs_java() {
        let mc = plan
            .mc_version()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        // Modpack: MC version unknown until parse — still require *some* compatible Java.
        // Use a conservative required major via a placeholder; prefer 21 if unknown.
        let check_ver = if mc == "unknown" { "1.20.1" } else { &mc };
        Some(require_java_or_err(check_ver)?)
    } else {
        None
    };

    let minecraft_path = get_minecraft_dir()?;
    std::fs::create_dir_all(&minecraft_path).map_err(|e| format!("创建目录失败: {}", e))?;

    let session = build_session(
        plan,
        retarget_source_instance,
        minecraft_path,
        java_path,
        legacy,
    )?;
    Ok(spawn_session(app, session))
}

/// Shared entry used by legacy command shims. Returns download_task_id for compat.
pub async fn start_legacy(
    app: AppHandle,
    plan: InstallPlan,
    legacy: LegacyEventFamily,
) -> Result<u64, String> {
    let start = start_with_plan(app, plan, None, legacy).await?;
    Ok(start.download_task_id)
}

pub async fn start_combined_legacy(
    app: AppHandle,
    mc_version: String,
    selections: Vec<LoaderSelection>,
    instance_name: Option<String>,
) -> Result<u64, String> {
    let plan = InstallPlan::combined(mc_version, selections, instance_name)?;
    start_legacy(app, plan, LegacyEventFamily::Combined).await
}

pub async fn start_vanilla_legacy(
    app: AppHandle,
    mc_version: String,
    instance_name: Option<String>,
) -> Result<u64, String> {
    let plan = InstallPlan::vanilla_only(mc_version, instance_name);
    start_legacy(app, plan, LegacyEventFamily::Vanilla).await
}

pub async fn start_loader_legacy(
    app: AppHandle,
    loader_type: &str,
    mc_version: String,
    loader_version: String,
    api_version: Option<String>,
    instance_name: Option<String>,
    legacy: LegacyEventFamily,
) -> Result<u64, String> {
    let plan = InstallPlan::single_loader(
        loader_type.to_string(),
        mc_version,
        loader_version,
        api_version,
        instance_name,
    )?;
    start_legacy(app, plan, legacy).await
}

pub async fn start_modpack_legacy(app: AppHandle, zip_path: String) -> Result<u64, String> {
    let plan = InstallPlan::modpack(zip_path);
    start_legacy(app, plan, LegacyEventFamily::Modpack).await
}
