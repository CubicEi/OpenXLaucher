//! Dual-task download/install orchestration.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::AppHandle;

use crate::downloader::fabric_installer;
use crate::downloader::forge_installer;
use crate::downloader::liteloader_installer;
use crate::downloader::neoforge_installer;
use crate::downloader::optifine_installer;
use crate::downloader::original_dwl::{process_version, ProgressUpdate};
use crate::downloader::quilt_installer;
use crate::downloader::shared_utils::{
    cleanup_loader_version_dir, cleanup_vanilla_version_dir,
    cleanup_vanilla_version_dir_after_combined, copy_version_mods_to_instance,
    create_vanilla_instance, merge_version_jsons_to_instance, sanitize_instance_name,
    scrub_vanilla_staging_dir,
};
use crate::downloader::modpack_installer;
use crate::version_management::copy_instance_user_data;

use super::events::{
    emit_download_progress, emit_install_progress, emit_session_started, emit_task_finished,
    TaskRole, VersionInstallSessionStartedPayload,
};
use super::plan::{ArtifactKind, InstallPlan, LoaderSelection};
use super::progress_network::{
    credit_bucket_empty, map_into_bucket, ProgressBucket, VANILLA_END,
};
use super::session::{
    register_session, to_start_result, unregister_session, InstallSession,
    VersionInstallSessionStart,
};
use super::stages::{
    STAGE_CLEANUP, STAGE_COMMUNITY, STAGE_DONE, STAGE_LOADER, STAGE_LOADER_INSTALLER, STAGE_MERGE,
    STAGE_OPTIFINE, STAGE_PREP, STAGE_RESOURCES, STAGE_TRANSFER, STAGE_VANILLA, STAGE_WAITING,
};

fn ensure_not_cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("已取消".to_string())
    } else {
        Ok(())
    }
}

fn loader_type_hint(loader_type: &str) -> &'static str {
    match loader_type {
        "forge" => "forge",
        "neoforge" => "neoforge",
        "fabric" => "fabric",
        "quilt" => "quilt",
        "liteloader" => "liteloader",
        "optifine" => "optifine",
        _ => "vanilla",
    }
}

/// Start a session: register, emit bootstrap, spawn workers. Returns start result.
pub fn spawn_session(app: AppHandle, session: InstallSession) -> VersionInstallSessionStart {
    let start = to_start_result(&session);
    register_session(&session);

    emit_session_started(
        &app,
        &VersionInstallSessionStartedPayload {
            session_id: session.session_id.clone(),
            download_task_id: session.download_task_id,
            install_task_id: session.install_task_id,
            display_name: session.display_name.clone(),
            plan_kind: session.plan.plan_kind().to_string(),
        },
    );

    emit_download_progress(
        &app,
        &session.session_id,
        session.download_task_id,
        0.0,
        STAGE_PREP,
        None,
        None,
        None,
        session.legacy,
    );
    emit_install_progress(
        &app,
        &session.session_id,
        session.install_task_id,
        STAGE_WAITING,
        None,
    );

    let app2 = app.clone();
    tokio::spawn(async move {
        run_session_workers(app2, session).await;
    });

    start
}

async fn run_session_workers(app: AppHandle, session: InstallSession) {
    let session = Arc::new(session);
    let download_session = session.clone();
    let install_session = session.clone();
    let app_dl = app.clone();
    let app_ins = app.clone();

    let download_handle = tokio::spawn(async move {
        run_download_worker(app_dl, download_session).await
    });
    let install_handle = tokio::spawn(async move {
        run_install_worker(app_ins, install_session).await
    });

    let (dl_res, ins_res) = tokio::join!(download_handle, install_handle);
    let dl_res = dl_res.unwrap_or_else(|e| Err(e.to_string()));
    let ins_res = ins_res.unwrap_or_else(|e| Err(e.to_string()));

    let cancelled = session.cancel.load(Ordering::SeqCst);
    let dl_ok = dl_res.is_ok();
    let ins_ok = matches!(ins_res.as_ref(), Ok(Some(_)) | Ok(None));
    // install returns Ok(Some(name)) or Ok(None) for vanilla-name cases; Err on fail
    let (ins_success, instance_name, ins_err) = match &ins_res {
        Ok(name) => (true, name.clone(), None),
        Err(e) => (false, None, Some(e.clone())),
    };
    let dl_err = dl_res.err();

    if cancelled || dl_err.is_some() || !ins_success {
        session.ledger.rollback();
    } else {
        session.ledger.cleanup_temp_only();
    }

    let fail_msg = if cancelled {
        Some("已取消".to_string())
    } else {
        dl_err.or(ins_err)
    };

    // Download finished (if not already emitted inside worker on early fail — emit again is ok for cancel)
    emit_task_finished(
        &app,
        &session.session_id,
        session.download_task_id,
        TaskRole::Download,
        dl_ok && !cancelled,
        if dl_ok && !cancelled {
            None
        } else {
            fail_msg.clone()
        },
        None,
        session.legacy,
    );
    emit_task_finished(
        &app,
        &session.session_id,
        session.install_task_id,
        TaskRole::Install,
        ins_success && !cancelled && dl_ok,
        if ins_success && !cancelled && dl_ok {
            None
        } else {
            fail_msg
        },
        instance_name,
        session.legacy,
    );

    unregister_session(&session.session_id);
    let _ = (ins_ok,);
}

async fn run_download_worker(app: AppHandle, session: Arc<InstallSession>) -> Result<(), String> {
    let cancel = session.cancel.clone();
    ensure_not_cancelled(&cancel)?;

    match &session.plan {
        InstallPlan::Modpack { zip_path } => {
            // Modpack: download/external fetch happens inside installer; we drive
            // percent from its progress channel and treat install worker as merge/cleanup.
            download_modpack_files(&app, &session, zip_path).await
        }
        _ => download_standard(&app, &session).await,
    }
}

async fn download_standard(app: &AppHandle, session: &InstallSession) -> Result<(), String> {
    let cancel = session.cancel.clone();
    let mc_version = session
        .plan
        .mc_version()
        .ok_or_else(|| "缺少 MC 版本".to_string())?
        .to_string();
    let minecraft_path = session.minecraft_path.clone();
    let legacy = session.legacy;

    // --- Vanilla bucket 0–60 ---
    emit_download_progress(
        app,
        &session.session_id,
        session.download_task_id,
        0.0,
        STAGE_VANILLA,
        None,
        None,
        None,
        legacy,
    );

    let vanilla_json = minecraft_path
        .join("versions")
        .join(&mc_version)
        .join(format!("{}.json", mc_version));
    let vanilla_jar = minecraft_path
        .join("versions")
        .join(&mc_version)
        .join(format!("{}.jar", mc_version));
    let vanilla_pre_existed = vanilla_json.exists() && vanilla_jar.exists();

    if vanilla_pre_existed {
        let _ = std::fs::write(session.staging_root.join("vanilla_pre_existed.flag"), b"1");
        println!(
            "[VersionInstall] vanilla {} already present — credit bucket",
            mc_version
        );
        let sid = session.session_id.clone();
        let tid = session.download_task_id;
        let app2 = app.clone();
        credit_bucket_empty(
            |pct| {
                emit_download_progress(
                    &app2,
                    &sid,
                    tid,
                    pct,
                    STAGE_VANILLA,
                    None,
                    None,
                    None,
                    legacy,
                );
            },
            ProgressBucket::Vanilla,
            &cancel,
        )
        .await;
    } else {
        let _ = std::fs::write(session.staging_root.join("vanilla_downloaded.flag"), b"1");
        session
            .ledger
            .mark_created(minecraft_path.join("versions").join(&mc_version));
        let (tx, mut rx) = tokio::sync::mpsc::channel::<ProgressUpdate>(64);
        let app2 = app.clone();
        let sid = session.session_id.clone();
        let tid = session.download_task_id;
        let cancel_fwd = cancel.clone();
        tokio::spawn(async move {
            while let Some(update) = rx.recv().await {
                if cancel_fwd.load(Ordering::SeqCst) {
                    break;
                }
                let global = map_into_bucket(ProgressBucket::Vanilla, update.percent);
                // original_dwl now separates network speed; pass through as-is
                emit_download_progress(
                    &app2,
                    &sid,
                    tid,
                    global,
                    STAGE_VANILLA,
                    update.speed,
                    update.downloaded,
                    update.message,
                    legacy,
                );
            }
        });
        process_version(&mc_version, &minecraft_path, tx, cancel.clone())
            .await
            .map_err(|e| {
                let msg = e.to_string();
                if msg.contains("已取消") || cancel.load(Ordering::SeqCst) {
                    "已取消".to_string()
                } else {
                    format!("原版下载失败: {}", msg)
                }
            })?;
        ensure_not_cancelled(&cancel)?;
        emit_download_progress(
            app,
            &session.session_id,
            session.download_task_id,
            VANILLA_END,
            STAGE_VANILLA,
            None,
            None,
            None,
            legacy,
        );
    }
    session.artifacts.mark_ready(ArtifactKind::Vanilla);

    // --- Loader installer bucket 60–85 ---
    if session.plan.has_mod_loader() || matches!(
        &session.plan,
        InstallPlan::SingleLoader {
            loader_type,
            ..
        } if loader_type == "optifine"
    ) || matches!(&session.plan, InstallPlan::Combined { selections, .. } if selections.iter().any(|s| s.loader_type == "optifine"))
    {
        // Short-term: mark loader installer as "download via install worker".
        // Credit the bucket with a short animation; install worker runs full installer.
        emit_download_progress(
            app,
            &session.session_id,
            session.download_task_id,
            VANILLA_END,
            STAGE_LOADER_INSTALLER,
            None,
            None,
            None,
            legacy,
        );
        let sid = session.session_id.clone();
        let tid = session.download_task_id;
        let app2 = app.clone();
        credit_bucket_empty(
            |pct| {
                emit_download_progress(
                    &app2,
                    &sid,
                    tid,
                    pct,
                    STAGE_LOADER_INSTALLER,
                    None,
                    None,
                    None,
                    legacy,
                );
            },
            ProgressBucket::LoaderInstaller,
            &cancel,
        )
        .await;
        session
            .artifacts
            .mark_ready(ArtifactKind::LoaderInstaller);
        if matches!(
            &session.plan,
            InstallPlan::SingleLoader {
                loader_type,
                ..
            } if loader_type == "optifine"
        ) || matches!(&session.plan, InstallPlan::Combined { selections, .. } if selections.iter().any(|s| s.loader_type == "optifine"))
        {
            session.artifacts.mark_ready(ArtifactKind::OptiFine);
        }
    } else {
        let sid = session.session_id.clone();
        let tid = session.download_task_id;
        let app2 = app.clone();
        credit_bucket_empty(
            |pct| {
                emit_download_progress(
                    &app2,
                    &sid,
                    tid,
                    pct,
                    STAGE_LOADER_INSTALLER,
                    None,
                    None,
                    None,
                    legacy,
                );
            },
            ProgressBucket::LoaderInstaller,
            &cancel,
        )
        .await;
    }

    // --- Extras bucket 85–100 ---
    if session.plan.has_extras() {
        emit_download_progress(
            app,
            &session.session_id,
            session.download_task_id,
            85.0,
            STAGE_COMMUNITY,
            None,
            None,
            None,
            legacy,
        );
        // Fabric API / OptiFine download occurs in install worker for now; credit bucket.
        let sid = session.session_id.clone();
        let tid = session.download_task_id;
        let app2 = app.clone();
        credit_bucket_empty(
            |pct| {
                emit_download_progress(
                    &app2,
                    &sid,
                    tid,
                    pct,
                    STAGE_COMMUNITY,
                    None,
                    None,
                    None,
                    legacy,
                );
            },
            ProgressBucket::Extras,
            &cancel,
        )
        .await;
        session.artifacts.mark_ready(ArtifactKind::FabricApi);
        session.artifacts.mark_ready(ArtifactKind::CommunityExtras);
    } else {
        let sid = session.session_id.clone();
        let tid = session.download_task_id;
        let app2 = app.clone();
        credit_bucket_empty(
            |pct| {
                emit_download_progress(
                    &app2,
                    &sid,
                    tid,
                    pct,
                    STAGE_COMMUNITY,
                    None,
                    None,
                    None,
                    legacy,
                );
            },
            ProgressBucket::Extras,
            &cancel,
        )
        .await;
    }

    emit_download_progress(
        app,
        &session.session_id,
        session.download_task_id,
        100.0,
        STAGE_COMMUNITY,
        None,
        None,
        None,
        legacy,
    );
    Ok(())
}

async fn download_modpack_files(
    app: &AppHandle,
    session: &InstallSession,
    zip_path: &str,
) -> Result<(), String> {
    // Mark vanilla/loader ready after modpack installer completes download phases.
    // The install worker waits on ModpackFiles; we run the full modpack install here
    // for progress correctness, then signal ready so install worker only does cleanup emit.
    let cancel = session.cancel.clone();
    ensure_not_cancelled(&cancel)?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<(usize, usize, String, String)>(64);
    let app2 = app.clone();
    let sid = session.session_id.clone();
    let tid = session.download_task_id;
    let legacy = session.legacy;
    let cancel_fwd = cancel.clone();
    tokio::spawn(async move {
        while let Some((downloaded, total, fname, _stage)) = rx.recv().await {
            if cancel_fwd.load(Ordering::SeqCst) {
                break;
            }
            let percent = if total == 0 {
                0.0
            } else {
                (downloaded as f64 / total as f64) * 100.0
            };
            let percent = percent.clamp(0.0, 99.5);
            emit_download_progress(
                &app2,
                &sid,
                tid,
                percent,
                STAGE_COMMUNITY,
                None,
                Some(downloaded as u64),
                if fname.is_empty() {
                    None
                } else {
                    Some(fname)
                },
                legacy,
            );
        }
    });

    let minecraft_dir = session.minecraft_path.clone();
    let _java = session.java_path.as_deref();
    let result = modpack_installer::download_modpack_from_zip(
        Path::new(zip_path),
        &minecraft_dir,
        Some(tx),
    )
    .await
    .map_err(|e| e.to_string());

    match result {
        Ok((instance_name, _count)) => {
            // Stash instance name via created path for install worker
            session
                .ledger
                .mark_created(minecraft_dir.join("versions").join(&instance_name));
            session.artifacts.mark_ready(ArtifactKind::Vanilla);
            session.artifacts.mark_ready(ArtifactKind::LoaderInstaller);
            session.artifacts.mark_ready(ArtifactKind::ModpackFiles);
            // Store instance name in a side channel: write a marker file in staging
            let marker = session.staging_root.join("modpack_instance_name.txt");
            let _ = std::fs::write(&marker, &instance_name);
            emit_download_progress(
                app,
                &session.session_id,
                session.download_task_id,
                100.0,
                STAGE_COMMUNITY,
                None,
                None,
                None,
                legacy,
            );
            Ok(())
        }
        Err(e) => {
            session.artifacts.mark_failed(ArtifactKind::ModpackFiles);
            Err(e)
        }
    }
}

async fn run_install_worker(
    app: AppHandle,
    session: Arc<InstallSession>,
) -> Result<Option<String>, String> {
    let cancel = session.cancel.clone();

    // Modpack: download worker already installed; just finish stages.
    if matches!(&session.plan, InstallPlan::Modpack { .. }) {
        emit_install_progress(
            &app,
            &session.session_id,
            session.install_task_id,
            STAGE_WAITING,
            None,
        );
        session
            .artifacts
            .wait(ArtifactKind::ModpackFiles, &cancel)
            .await?;
        ensure_not_cancelled(&cancel)?;
        let zip_path = session
            .plan
            .modpack_zip_path()
            .ok_or_else(|| "缺少整合包路径".to_string())?;
        emit_install_progress(
            &app,
            &session.session_id,
            session.install_task_id,
            STAGE_LOADER,
            None,
        );
        let java = session.java_path.as_deref();
        let install_result = modpack_installer::install_modpack_after_download(
            Path::new(zip_path),
            &session.minecraft_path,
            java,
        )
        .await
        .map_err(|e| e.to_string());
        ensure_not_cancelled(&cancel)?;
        return match install_result {
            Ok((instance_name, _)) => {
                emit_install_progress(
                    &app,
                    &session.session_id,
                    session.install_task_id,
                    STAGE_MERGE,
                    None,
                );
                emit_install_progress(
                    &app,
                    &session.session_id,
                    session.install_task_id,
                    STAGE_CLEANUP,
                    None,
                );
                emit_install_progress(
                    &app,
                    &session.session_id,
                    session.install_task_id,
                    STAGE_DONE,
                    None,
                );
                Ok(Some(instance_name))
            }
            Err(e) => Err(e),
        };
    }

    emit_install_progress(
        &app,
        &session.session_id,
        session.install_task_id,
        STAGE_WAITING,
        None,
    );
    session
        .artifacts
        .wait(ArtifactKind::Vanilla, &cancel)
        .await?;
    ensure_not_cancelled(&cancel)?;

    let mc_version = session
        .plan
        .mc_version()
        .ok_or_else(|| "缺少 MC 版本".to_string())?
        .to_string();
    let minecraft_path = session.minecraft_path.clone();
    let java = session.java_path.clone().unwrap_or_default();

    let (loader_version_name, optifine_version_name, selections_for_mods) =
        install_loaders(&app, &session, &mc_version, &minecraft_path, &java).await?;

    ensure_not_cancelled(&cancel)?;
    emit_install_progress(
        &app,
        &session.session_id,
        session.install_task_id,
        STAGE_MERGE,
        None,
    );

    let instance_name = resolve_instance_name(&session.plan, loader_version_name.as_ref(), optifine_version_name.as_ref());
    let loader_target = optifine_version_name
        .as_ref()
        .or(loader_version_name.as_ref());

    if let Some(loader_ver) = loader_target {
        let hint = if optifine_version_name.is_some() {
            "optifine"
        } else {
            match &session.plan {
                InstallPlan::Combined { selections, .. } => selections
                    .iter()
                    .find(|s| {
                        matches!(
                            s.loader_type.as_str(),
                            "forge" | "neoforge" | "fabric" | "quilt" | "liteloader"
                        )
                    })
                    .map(|s| loader_type_hint(&s.loader_type))
                    .unwrap_or("vanilla"),
                InstallPlan::SingleLoader { loader_type, .. } => loader_type_hint(loader_type),
                _ => "vanilla",
            }
        };
        session
            .ledger
            .mark_created(minecraft_path.join("versions").join(&instance_name));
        merge_version_jsons_to_instance(
            &instance_name,
            &mc_version,
            loader_ver,
            hint,
            &minecraft_path,
        )
        .map_err(|e| format!("合并实例 JSON 失败: {}", e))?;
    } else {
        session
            .ledger
            .mark_created(minecraft_path.join("versions").join(&instance_name));
        create_vanilla_instance(&instance_name, &mc_version, &minecraft_path)
            .map_err(|e| format!("创建原版实例失败: {}", e))?;
        if instance_name != mc_version {
            cleanup_vanilla_version_dir(&mc_version, &minecraft_path);
        }
    }

    ensure_not_cancelled(&cancel)?;
    emit_install_progress(
        &app,
        &session.session_id,
        session.install_task_id,
        STAGE_RESOURCES,
        None,
    );

    if selections_for_mods
        .iter()
        .any(|s| s.loader_type == "fabric_api")
    {
        copy_version_mods_to_instance(&instance_name, &mc_version, &minecraft_path);
    }
    if optifine_version_name.is_some() {
        if let Some(loader_ver) = loader_version_name.as_ref() {
            copy_version_mods_to_instance(&instance_name, loader_ver, &minecraft_path);
        }
    }

    // Also handle SingleLoader fabric/quilt api
    if let InstallPlan::SingleLoader {
        api_version: Some(_),
        loader_type,
        ..
    } = &session.plan
    {
        if loader_type == "fabric" || loader_type == "quilt" {
            copy_version_mods_to_instance(&instance_name, &mc_version, &minecraft_path);
        }
    }

    ensure_not_cancelled(&cancel)?;
    if let Some(source) = session.retarget_source_instance.as_deref() {
        if source != instance_name {
            emit_install_progress(
                &app,
                &session.session_id,
                session.install_task_id,
                STAGE_TRANSFER,
                None,
            );
            copy_instance_user_data(&minecraft_path, source, &instance_name)
                .map_err(|e| format!("转移用户数据失败: {}", e))?;
        }
    }

    ensure_not_cancelled(&cancel)?;
    emit_install_progress(
        &app,
        &session.session_id,
        session.install_task_id,
        STAGE_CLEANUP,
        None,
    );

    if let Some(of_ver) = optifine_version_name.as_ref() {
        if of_ver != &instance_name {
            cleanup_loader_version_dir(of_ver, &minecraft_path);
        }
    }
    if let Some(loader_ver) = loader_version_name.as_ref() {
        if loader_ver != &instance_name {
            cleanup_loader_version_dir(loader_ver, &minecraft_path);
        }
    }
    if loader_target.is_some() {
        scrub_vanilla_staging_dir(&mc_version, &minecraft_path);
        let downloaded_vanilla = session
            .staging_root
            .join("vanilla_downloaded.flag")
            .exists();
        let pre = session
            .staging_root
            .join("vanilla_pre_existed.flag")
            .exists();
        cleanup_vanilla_version_dir_after_combined(
            &mc_version,
            &minecraft_path,
            &instance_name,
            downloaded_vanilla,
            pre,
        );
        // Prefer trash for intermediate vanilla when policy deletes — shared_utils uses remove_dir_all.
        // Plan asks for trash::delete pattern; attempt trash if dir still exists after cleanup helper.
        let leftover = minecraft_path.join("versions").join(&mc_version);
        if leftover.is_dir() && instance_name != mc_version && !pre {
            let _ = trash::delete(&leftover);
        }
    }

    emit_install_progress(
        &app,
        &session.session_id,
        session.install_task_id,
        STAGE_DONE,
        None,
    );
    Ok(Some(instance_name))
}

fn resolve_instance_name(
    plan: &InstallPlan,
    loader_version_name: Option<&String>,
    optifine_version_name: Option<&String>,
) -> String {
    let mc_version = plan.mc_version().unwrap_or("unknown");
    let loader_target = optifine_version_name.or(loader_version_name);
    let instance_name = match plan {
        InstallPlan::Combined { instance_name, .. }
        | InstallPlan::VanillaOnly { instance_name, .. }
        | InstallPlan::SingleLoader { instance_name, .. } => instance_name.as_deref(),
        InstallPlan::Modpack { .. } => None,
    };
    if let Some(inst) = instance_name {
        let clean = sanitize_instance_name(inst);
        if clean.trim().is_empty() {
            loader_target
                .map(|s| sanitize_instance_name(s))
                .unwrap_or_else(|| sanitize_instance_name(mc_version))
        } else {
            clean
        }
    } else {
        loader_target
            .map(|s| sanitize_instance_name(s))
            .unwrap_or_else(|| sanitize_instance_name(mc_version))
    }
}

async fn install_loaders(
    app: &AppHandle,
    session: &InstallSession,
    mc_version: &str,
    minecraft_path: &Path,
    java: &str,
) -> Result<(Option<String>, Option<String>, Vec<LoaderSelection>), String> {
    let cancel = &session.cancel;
    let mc_path_str = minecraft_path.to_string_lossy().to_string();

    let (mod_loader, optifine, fabric_api, selections): (
        Option<(String, String)>,
        Option<String>,
        Option<String>,
        Vec<LoaderSelection>,
    ) = match &session.plan {
        InstallPlan::Combined { selections, .. } => {
            let ml = selections
                .iter()
                .find(|s| {
                    matches!(
                        s.loader_type.as_str(),
                        "forge" | "neoforge" | "fabric" | "quilt" | "liteloader"
                    )
                })
                .map(|s| (s.loader_type.clone(), s.version.clone()));
            let of = selections
                .iter()
                .find(|s| s.loader_type == "optifine")
                .map(|s| s.version.clone());
            let api = selections
                .iter()
                .find(|s| s.loader_type == "fabric_api")
                .map(|s| s.version.clone());
            (ml, of, api, selections.clone())
        }
        InstallPlan::SingleLoader {
            loader_type,
            loader_version,
            api_version,
            ..
        } => {
            if loader_type == "optifine" {
                (
                    None,
                    Some(loader_version.clone()),
                    None,
                    vec![LoaderSelection {
                        loader_type: loader_type.clone(),
                        version: loader_version.clone(),
                    }],
                )
            } else {
                (
                    Some((loader_type.clone(), loader_version.clone())),
                    None,
                    api_version.clone(),
                    vec![LoaderSelection {
                        loader_type: loader_type.clone(),
                        version: loader_version.clone(),
                    }],
                )
            }
        }
        InstallPlan::VanillaOnly { .. } | InstallPlan::Modpack { .. } => (None, None, None, vec![]),
    };

    let mut loader_version_name: Option<String> = None;
    let mut optifine_version_name: Option<String> = None;

    if let Some((loader_type, loader_ver)) = mod_loader {
        session
            .artifacts
            .wait(ArtifactKind::LoaderInstaller, cancel)
            .await
            .ok();
        ensure_not_cancelled(cancel)?;
        emit_install_progress(
            app,
            &session.session_id,
            session.install_task_id,
            STAGE_LOADER,
            Some(loader_type.clone()),
        );

        let original_ready = Arc::new(AtomicBool::new(true)); // vanilla already ready
        let name = match loader_type.as_str() {
            "forge" => forge_installer::install_forge(
                mc_version,
                &loader_ver,
                &mc_path_str,
                java,
                None,
                None,
                Some(original_ready),
            )
            .await
            .map_err(|e| e.to_string())?,
            "neoforge" => neoforge_installer::install_neoforge(
                mc_version,
                &loader_ver,
                &mc_path_str,
                java,
                None,
                None,
                Some(original_ready),
            )
            .await
            .map_err(|e| e.to_string())?,
            "fabric" => fabric_installer::install_fabric_loader(
                mc_version,
                &loader_ver,
                &mc_path_str,
                true,
                None,
                None,
            )
            .await
            .map_err(|e| e.to_string())?,
            "quilt" => quilt_installer::install_quilt_loader(
                mc_version,
                &loader_ver,
                &mc_path_str,
                None,
                None,
            )
            .await
            .map_err(|e| e.to_string())?,
            "liteloader" => liteloader_installer::install_liteloader(
                mc_version,
                &loader_ver,
                &mc_path_str,
                java,
                None,
            )
            .await
            .map_err(|e| e.to_string())?,
            other => return Err(format!("未知加载器: {}", other)),
        };
        session
            .ledger
            .mark_created(minecraft_path.join("versions").join(&name));
        loader_version_name = Some(name);

        if let Some(api_ver) = fabric_api {
            emit_install_progress(
                app,
                &session.session_id,
                session.install_task_id,
                STAGE_RESOURCES,
                Some("API".to_string()),
            );
            if loader_type == "quilt" {
                quilt_installer::install_quilt_api(mc_version, &api_ver, &mc_path_str, None)
                    .await
                    .map_err(|e| e.to_string())?;
            } else {
                fabric_installer::install_fabric_api(mc_version, &api_ver, &mc_path_str, None)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    if let Some(of_ver) = optifine {
        ensure_not_cancelled(cancel)?;
        emit_install_progress(
            app,
            &session.session_id,
            session.install_task_id,
            STAGE_OPTIFINE,
            None,
        );
        let mc_dir = Path::new(&mc_path_str);
        let name = if of_ver.starts_with("http://") || of_ver.starts_with("https://") {
            optifine_installer::install_optifine_from_bmcl_with_fallback(
                mc_version,
                &of_ver,
                &of_ver,
                mc_dir,
            )
            .await
            .map_err(|e| e.to_string())?
        } else {
            optifine_installer::install_optifine_from_local(Path::new(&of_ver), mc_dir, mc_version)
                .await
                .map_err(|e| e.to_string())?
        };
        session
            .ledger
            .mark_created(minecraft_path.join("versions").join(&name));
        optifine_version_name = Some(name);
    }

    Ok((loader_version_name, optifine_version_name, selections))
}
