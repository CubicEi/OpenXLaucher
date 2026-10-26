//! Install plan built from combined selections, vanilla-only, single loader, or modpack.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CombinedSelectionInput {
    /// Accept both camelCase (loaderType) and snake (loader_type) from FE.
    #[serde(alias = "loader_type")]
    pub loader_type: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VersionInstallPlanInput {
    /// Field renames: enum `rename_all` only affects variant tags, not variant fields.
    /// Accept FE camelCase (`mcVersion`) and legacy snake_case.
    #[serde(rename = "combined")]
    Combined {
        #[serde(rename = "mcVersion", alias = "mc_version")]
        mc_version: String,
        selections: Vec<CombinedSelectionInput>,
        #[serde(default, rename = "instanceName", alias = "instance_name")]
        instance_name: Option<String>,
        #[serde(default, rename = "retargetSourceInstance", alias = "retarget_source_instance")]
        retarget_source_instance: Option<String>,
    },
    #[serde(rename = "vanillaOnly")]
    VanillaOnly {
        #[serde(rename = "mcVersion", alias = "mc_version")]
        mc_version: String,
        #[serde(default, rename = "instanceName", alias = "instance_name")]
        instance_name: Option<String>,
        #[serde(default, rename = "retargetSourceInstance", alias = "retarget_source_instance")]
        retarget_source_instance: Option<String>,
    },
    #[serde(rename = "singleLoader")]
    SingleLoader {
        #[serde(rename = "loaderType", alias = "loader_type")]
        loader_type: String,
        #[serde(rename = "mcVersion", alias = "mc_version")]
        mc_version: String,
        #[serde(rename = "loaderVersion", alias = "loader_version")]
        loader_version: String,
        #[serde(default, rename = "apiVersion", alias = "api_version")]
        api_version: Option<String>,
        #[serde(default, rename = "instanceName", alias = "instance_name")]
        instance_name: Option<String>,
        #[serde(default, rename = "retargetSourceInstance", alias = "retarget_source_instance")]
        retarget_source_instance: Option<String>,
    },
    #[serde(rename = "modpack")]
    Modpack {
        #[serde(rename = "zipPath", alias = "zip_path")]
        zip_path: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ArtifactKind {
    Vanilla,
    LoaderInstaller,
    OptiFine,
    FabricApi,
    CommunityExtras,
    ModpackFiles,
}

#[derive(Debug, Clone)]
pub struct LoaderSelection {
    pub loader_type: String,
    pub version: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedInstallPlan {
    pub plan: InstallPlan,
    pub retarget_source_instance: Option<String>,
}

#[derive(Debug, Clone)]
pub enum InstallPlan {
    Combined {
        mc_version: String,
        selections: Vec<LoaderSelection>,
        instance_name: Option<String>,
    },
    VanillaOnly {
        mc_version: String,
        instance_name: Option<String>,
    },
    SingleLoader {
        loader_type: String,
        mc_version: String,
        loader_version: String,
        api_version: Option<String>,
        instance_name: Option<String>,
    },
    Modpack {
        zip_path: String,
    },
}

fn normalize_retarget(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl InstallPlan {
    pub fn from_input(input: VersionInstallPlanInput) -> Result<ResolvedInstallPlan, String> {
        match input {
            VersionInstallPlanInput::Combined {
                mc_version,
                selections,
                instance_name,
                retarget_source_instance,
            } => {
                let sels: Vec<LoaderSelection> = selections
                    .into_iter()
                    .map(|s| LoaderSelection {
                        loader_type: s.loader_type,
                        version: s.version,
                    })
                    .collect();
                validate_selections(&sels)?;
                Ok(ResolvedInstallPlan {
                    plan: Self::Combined {
                        mc_version,
                        selections: sels,
                        instance_name,
                    },
                    retarget_source_instance: normalize_retarget(retarget_source_instance),
                })
            }
            VersionInstallPlanInput::VanillaOnly {
                mc_version,
                instance_name,
                retarget_source_instance,
            } => Ok(ResolvedInstallPlan {
                plan: Self::VanillaOnly {
                    mc_version,
                    instance_name,
                },
                retarget_source_instance: normalize_retarget(retarget_source_instance),
            }),
            VersionInstallPlanInput::SingleLoader {
                loader_type,
                mc_version,
                loader_version,
                api_version,
                instance_name,
                retarget_source_instance,
            } => {
                if !is_known_loader(&loader_type) {
                    return Err(format!("未知加载器类型: {}", loader_type));
                }
                Ok(ResolvedInstallPlan {
                    plan: Self::SingleLoader {
                        loader_type,
                        mc_version,
                        loader_version,
                        api_version,
                        instance_name,
                    },
                    retarget_source_instance: normalize_retarget(retarget_source_instance),
                })
            }
            VersionInstallPlanInput::Modpack { zip_path } => {
                if zip_path.trim().is_empty() {
                    return Err("整合包路径为空".to_string());
                }
                Ok(ResolvedInstallPlan {
                    plan: Self::Modpack { zip_path },
                    retarget_source_instance: None,
                })
            }
        }
    }

    pub fn combined(
        mc_version: String,
        selections: Vec<LoaderSelection>,
        instance_name: Option<String>,
    ) -> Result<Self, String> {
        validate_selections(&selections)?;
        Ok(Self::Combined {
            mc_version,
            selections,
            instance_name,
        })
    }

    pub fn vanilla_only(mc_version: String, instance_name: Option<String>) -> Self {
        Self::VanillaOnly {
            mc_version,
            instance_name,
        }
    }

    pub fn single_loader(
        loader_type: String,
        mc_version: String,
        loader_version: String,
        api_version: Option<String>,
        instance_name: Option<String>,
    ) -> Result<Self, String> {
        if !is_known_loader(&loader_type) {
            return Err(format!("未知加载器类型: {}", loader_type));
        }
        Ok(Self::SingleLoader {
            loader_type,
            mc_version,
            loader_version,
            api_version,
            instance_name,
        })
    }

    pub fn modpack(zip_path: String) -> Self {
        Self::Modpack { zip_path }
    }

    pub fn mc_version(&self) -> Option<&str> {
        match self {
            Self::Combined { mc_version, .. }
            | Self::VanillaOnly { mc_version, .. }
            | Self::SingleLoader { mc_version, .. } => Some(mc_version.as_str()),
            Self::Modpack { .. } => None,
        }
    }

    pub fn modpack_zip_path(&self) -> Option<&str> {
        match self {
            Self::Modpack { zip_path } => Some(zip_path.as_str()),
            _ => None,
        }
    }

    pub fn display_name(&self) -> String {
        match self {
            Self::Combined {
                mc_version,
                instance_name,
                selections,
                ..
            } => instance_name
                .as_ref()
                .filter(|s| !s.trim().is_empty())
                .cloned()
                .unwrap_or_else(|| {
                    selections
                        .iter()
                        .find(|s| is_mod_loader(&s.loader_type))
                        .map(|s| format!("{}-{}", mc_version, s.version))
                        .unwrap_or_else(|| mc_version.clone())
                }),
            Self::VanillaOnly {
                mc_version,
                instance_name,
            } => instance_name
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| mc_version.clone()),
            Self::SingleLoader {
                mc_version,
                loader_version,
                instance_name,
                ..
            } => instance_name
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("{}-{}", mc_version, loader_version)),
            Self::Modpack { zip_path } => std::path::Path::new(zip_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "整合包".to_string()),
        }
    }

    pub fn plan_kind(&self) -> &'static str {
        match self {
            Self::Combined { .. } => "combined",
            Self::VanillaOnly { .. } => "vanilla_only",
            Self::SingleLoader { .. } => "single_loader",
            Self::Modpack { .. } => "modpack",
        }
    }

    /// True when a mod loader / OptiFine installer / modpack needs a real Java executable.
    pub fn needs_java(&self) -> bool {
        match self {
            Self::VanillaOnly { .. } => false,
            Self::Combined { selections, .. } => selections.iter().any(|s| {
                is_mod_loader(&s.loader_type) || s.loader_type == "optifine"
            }),
            Self::SingleLoader { loader_type, .. } => {
                is_mod_loader(loader_type) || loader_type == "optifine"
            }
            // Modpack may install a loader; require Java up front.
            Self::Modpack { .. } => true,
        }
    }

    pub fn has_mod_loader(&self) -> bool {
        match self {
            Self::Combined { selections, .. } => {
                selections.iter().any(|s| is_mod_loader(&s.loader_type))
            }
            Self::SingleLoader { loader_type, .. } => is_mod_loader(loader_type),
            Self::VanillaOnly { .. } => false,
            Self::Modpack { .. } => true,
        }
    }

    pub fn has_extras(&self) -> bool {
        match self {
            Self::Combined { selections, .. } => selections.iter().any(|s| {
                matches!(s.loader_type.as_str(), "optifine" | "fabric_api")
            }),
            Self::SingleLoader {
                loader_type,
                api_version,
                ..
            } => loader_type == "optifine" || api_version.is_some(),
            Self::Modpack { .. } => true,
            Self::VanillaOnly { .. } => false,
        }
    }

    pub fn required_artifacts(&self) -> Vec<ArtifactKind> {
        let mut out = vec![ArtifactKind::Vanilla];
        if self.has_mod_loader() {
            out.push(ArtifactKind::LoaderInstaller);
        }
        match self {
            Self::Combined { selections, .. } => {
                if selections.iter().any(|s| s.loader_type == "optifine") {
                    out.push(ArtifactKind::OptiFine);
                }
                if selections.iter().any(|s| s.loader_type == "fabric_api") {
                    out.push(ArtifactKind::FabricApi);
                }
            }
            Self::SingleLoader {
                loader_type,
                api_version,
                ..
            } => {
                if loader_type == "optifine" {
                    out.push(ArtifactKind::OptiFine);
                }
                if api_version.is_some() {
                    out.push(ArtifactKind::FabricApi);
                }
            }
            Self::Modpack { .. } => {
                out.push(ArtifactKind::ModpackFiles);
            }
            Self::VanillaOnly { .. } => {}
        }
        out
    }
}

pub fn is_mod_loader(loader_type: &str) -> bool {
    matches!(
        loader_type,
        "forge" | "neoforge" | "fabric" | "quilt" | "liteloader"
    )
}

fn is_known_loader(loader_type: &str) -> bool {
    is_mod_loader(loader_type) || loader_type == "optifine"
}

pub fn validate_selections(selections: &[LoaderSelection]) -> Result<(), String> {
    let mod_loaders: Vec<&LoaderSelection> = selections
        .iter()
        .filter(|s| is_mod_loader(&s.loader_type))
        .collect();
    if mod_loaders.len() > 1 {
        return Err(
            "最多只能选择一个模组加载器（Forge/NeoForge/Fabric/Quilt/LiteLoader 互不兼容）"
                .to_string(),
        );
    }
    let has_fabric = mod_loaders.iter().any(|s| s.loader_type == "fabric");
    if selections.iter().any(|s| s.loader_type == "fabric_api") && !has_fabric {
        return Err("Fabric API 需要同时选择 Fabric 加载器".to_string());
    }
    if selections.iter().any(|s| s.loader_type == "optifine") {
        let conflict = mod_loaders
            .iter()
            .any(|s| matches!(s.loader_type.as_str(), "fabric" | "quilt" | "liteloader"));
        if conflict {
            return Err("OptiFine 不能与 Fabric/Quilt/LiteLoader 组合".to_string());
        }
    }
    Ok(())
}
