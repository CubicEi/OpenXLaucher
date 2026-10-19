use fastnbt::{from_bytes, to_bytes, Value};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub type PackInfo = (String, String, String);

/// 从 Value 中提取布尔值
/// Minecraft 的布尔值可能以多种形式存储：
/// - Byte: 1 或 0
/// - String: "true" 或 "false"（游戏规则常用）
fn parse_bool_value(value: &Value) -> bool {
    match value {
        Value::Byte(b) => *b != 0,
        Value::Short(s) => *s != 0,
        Value::Int(i) => *i != 0,
        Value::Long(l) => *l != 0,
        Value::String(s) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// 从 Value 中提取字符串值
fn parse_string_value(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Byte(b) => Some(b.to_string()),
        Value::Short(s) => Some(s.to_string()),
        Value::Int(i) => Some(i.to_string()),
        Value::Long(l) => Some(l.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        _ => None,
    }
}

/// 从 Value 中提取 i64 值（用于种子）
fn parse_long_value(value: &Value) -> Option<i64> {
    match value {
        Value::Long(l) => Some(*l),
        Value::Int(i) => Some(*i as i64),
        Value::Short(s) => Some(*s as i64),
        Value::Byte(b) => Some(*b as i64),
        Value::String(s) => s.parse::<i64>().ok(),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
pub struct LevelInfo {
    #[serde(default)]
    #[serde(rename = "RandomSeed")]
    pub random_seed: Option<i64>,
    
    #[serde(default)]
    #[serde(rename = "Seed")]
    pub seed: Option<i64>,
    
    #[serde(default)]
    #[serde(rename = "GameRules")]
    pub game_rules: Option<Value>,
    
    #[serde(default)]
    #[serde(rename = "WorldGenSettings")]
    pub world_gen_settings: Option<Value>,
    
    #[serde(default)]
    #[serde(rename = "allowCommands")]
    pub allow_commands: Option<Value>,
    
    // 1.18+ 的游戏规则可能存储在 Data 级别
    #[serde(default)]
    #[serde(rename = "keepInventory")]
    pub keep_inventory: Option<Value>,
    
    #[serde(default)]
    #[serde(rename = "mobGriefing")]
    pub mob_griefing: Option<Value>,
    
    #[serde(default)]
    #[serde(rename = "doFireTick")]
    pub do_fire_tick: Option<Value>,
}

impl Default for LevelInfo {
    fn default() -> Self {
        Self {
            random_seed: None,
            seed: None,
            game_rules: Some(Value::Compound(HashMap::new())),
            world_gen_settings: None,
            allow_commands: None,
            keep_inventory: None,
            mob_griefing: None,
            do_fire_tick: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RootCompound {
    #[serde(rename = "Data")]
    data: LevelInfo,
}

/// 解析单个光影包/材质包信息
fn parse_resource_pack(folder_abs_path: &str) -> Option<PackInfo> {
    let path = Path::new(folder_abs_path);

    // 1. 获取材质包文件夹名称
    let folder_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Unknown_Pack")
        .to_string();

    // 2. 查找 pack.png
    let pack_png_path = path.join("pack.png");
    let pack_png_str = if pack_png_path.exists() && pack_png_path.is_file() {
        pack_png_path.to_string_lossy().replace(r"\", "/")
    } else {
        String::new()
    };

    // 3. 解析 pack.mcmeta 获取版本号
    let version_string = get_mc_version(path);

    Some((folder_name, pack_png_str, version_string))
}

/// 遍历文件夹中的所有子文件夹，解析每个光影包/材质包信息
pub fn find_resource_packs(root_path: &str) -> Vec<PackInfo> {
    let root = Path::new(root_path).join("resourcepacks");
    let mut packs = Vec::new();

    // 读取根目录下的所有条目
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();

            // 只处理目录
            if path.is_dir() {
                // 尝试解析每个子文件夹
                if let Some(pack_info) =
                    parse_resource_pack(&path.to_string_lossy().replace(r"\", "/"))
                {
                    packs.push(pack_info);
                }
            }
        }
    }

    packs
}

/// 辅助函数：从 pack.mcmeta 中解析版本号
pub fn get_mc_version(folder_path: &Path) -> String {
    let mcmeta_path = folder_path.join("pack.mcmeta");

    // 如果文件不存在，返回空字符串
    if !mcmeta_path.exists() {
        return String::new();
    }

    // 读取文件内容
    let content = match fs::read_to_string(&mcmeta_path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.contains(r#""pack_format":"#) {
            // 找到包含 "pack_format": 的行
            // 提取冒号后面的数字部分
            if let Some(colon_pos) = trimmed.find(':') {
                let after_colon = &trimmed[colon_pos + 1..];
                // 提取数字（跳过可能的空格）
                let num_str: String = after_colon
                    .trim()
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();

                if let Ok(format_num) = num_str.parse::<u64>() {
                    return translate_pack_format_to_version(format_num);
                }
            }
        }
    }

    String::new()
}

fn translate_pack_format_to_version(format: u64) -> String {
    match format {
        1 => "1.6.1 ~ 1.8.9".to_string(),
        2 => "1.9 ~ 1.10.2".to_string(),
        3 => "1.11 ~ 1.12.2".to_string(),
        4 => "1.13 ~ 1.14.4".to_string(),
        5 => "1.15 ~ 1.16.1".to_string(),
        6 => "1.16.2 ~ 1.16.5".to_string(),
        7 => "1.17 ~ 1.17.1".to_string(),
        8 => "1.18 ~ 1.18.2".to_string(),
        9 => "1.19 ~ 1.19.2".to_string(),
        11 => "1.19.3".to_string(),
        12 => "1.19.4".to_string(),
        15 => "1.20 ~ 1.20.1".to_string(),
        18 => "1.20.2".to_string(),
        22 => "1.20.3~1.20.4".to_string(),
        32 => "1.20.5".to_string(),
        34 => "1.21".to_string(),
        46 => "1.21.4".to_string(),
        55 => "1.21.5".to_string(),
        63 => "1.21.6".to_string(),
        64 => "1.21.7~1.21.8".to_string(),
        // 如果遇到未知的版本号，返回数字本身或特定提示
        _ => format!("版本位置, 格式为 {}", format),
    }
}

/// 扫描根路径下的 instance 文件夹，返回所有文件夹的名称数组
pub fn scan_instances(instances_path: &Path) -> Vec<String> {
    let mut instance_names = Vec::new();

    // 检查 instances 文件夹是否存在
    if !instances_path.exists() || !instances_path.is_dir() {
        return instance_names;
    }

    // 读取 instances 文件夹下的所有条目
    if let Ok(entries) = fs::read_dir(instances_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            // 只处理目录
            if path.is_dir() {
                // 获取路径的最后一部分（文件夹名称）
                let folder_name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Unknown_Instance")
                    .to_string();
                instance_names.push(folder_name);
            }
        }
    }

    instance_names
}

/// 尝试解压 level.dat 文件内容
/// 支持两种格式：直接GZIP或带长度前缀的GZIP
fn decompress_level_dat(bytes: &[u8]) -> Result<Vec<u8>, ()> {
    use flate2::read::GzDecoder;
    use std::io::Read;

    // 先尝试直接解压（格式1）
    let mut decoder = GzDecoder::new(bytes);
    let mut decompressed = Vec::new();
    if decoder.read_to_end(&mut decompressed).is_ok() {
        // 验证是否是有效的NBT数据（应该以TAG_Compound的ID 10开头）
        if !decompressed.is_empty() && decompressed[0] == 10 {
            return Ok(decompressed);
        }
    }

    // 如果直接解压失败或数据无效，尝试格式2：跳过前4字节（小端序长度）
    if bytes.len() > 4 {
        let mut decoder = GzDecoder::new(&bytes[4..]);
        let mut decompressed = Vec::new();
        if decoder.read_to_end(&mut decompressed).is_ok() {
            if !decompressed.is_empty() && decompressed[0] == 10 {
                return Ok(decompressed);
            }
        }
    }

    Err(())
}

/// 解析level.dat文件，返回种子和游戏规则信息
/// 参数：world_folder_abs_path - 世界文件夹的绝对路径
/// 返回：Option<Vec<String>> - 包含RandomSeed或seed的值，keepInventory的值，mobGriefing的值，doFireTick的值，allowCommands的值的数组
pub fn parse_level_dat(world_folder_abs_path: &str) -> Option<Vec<String>> {
    let path = Path::new(world_folder_abs_path);
    let level_dat_path = path.join("level.dat");

    // 检查level.dat文件是否存在
    if !level_dat_path.exists() || !level_dat_path.is_file() {
        eprintln!("level.dat 文件不存在: {:?}", level_dat_path);
        return None;
    }

    // 读取文件内容
    let bytes = match fs::read(&level_dat_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("读取 level.dat 失败: {:?}", e);
            return None;
        }
    };

    // 使用改进的解压函数
    let decompressed = match decompress_level_dat(&bytes) {
        Ok(d) => d,
        Err(_) => {
            eprintln!("解压 level.dat 失败");
            return None;
        }
    };
    
    // 直接解析为 Value（动态类型）
    let root: Value = match from_bytes(&decompressed) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("解析 NBT 数据失败: {:?}", e);
            return None;
        }
    };
    
    // 使用 match 块一次性提取所有需要的数据
    let result = match root {
        Value::Compound(root_map) => {
            match root_map.get("Data") {
                Some(Value::Compound(data_compound)) => {
                    // ============ 获取种子值 ============
                    let seed_value = 
                        // 尝试 RandomSeed（传统位置）
                        data_compound.get("RandomSeed").and_then(|v| match v {
                            Value::Long(l) => Some(*l),
                            _ => None,
                        })
                        // 尝试 Seed
                        .or_else(|| data_compound.get("Seed").and_then(|v| match v {
                            Value::Long(l) => Some(*l),
                            _ => None,
                        }))
                        // 尝试 WorldGenSettings.seed（某些版本）
                        .or_else(|| {
                            if let Some(Value::Compound(settings)) = data_compound.get("WorldGenSettings") {
                                settings.get("seed").and_then(|v| match v {
                                    Value::Long(l) => Some(*l),
                                    Value::Int(i) => Some(*i as i64),
                                    _ => None,
                                })
                            } else {
                                None
                            }
                        })
                        // 尝试 WorldGenSettings.dimensions.minecraft:the_nether.generator.seed（1.18+ 版本）
                        .or_else(|| {
                            if let Some(Value::Compound(settings)) = data_compound.get("WorldGenSettings") {
                                if let Some(Value::Compound(dimensions)) = settings.get("dimensions") {
                                    if let Some(Value::Compound(nether)) = dimensions.get("minecraft:the_nether") {
                                        if let Some(Value::Compound(generator)) = nether.get("generator") {
                                            generator.get("seed").and_then(|v| match v {
                                                Value::Long(l) => Some(*l),
                                                Value::Int(i) => Some(*i as i64),
                                                _ => None,
                                            })
                                        } else {
                                            None
                                        }
                                    } else {
                                        None
                                    }
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        })
                        // 尝试 WorldGenSettings.dimensions.minecraft:overworld.generator.seed（备用）
                        .or_else(|| {
                            if let Some(Value::Compound(settings)) = data_compound.get("WorldGenSettings") {
                                if let Some(Value::Compound(dimensions)) = settings.get("dimensions") {
                                    if let Some(Value::Compound(overworld)) = dimensions.get("minecraft:overworld") {
                                        if let Some(Value::Compound(generator)) = overworld.get("generator") {
                                            generator.get("seed").and_then(|v| match v {
                                                Value::Long(l) => Some(*l),
                                                Value::Int(i) => Some(*i as i64),
                                                _ => None,
                                            })
                                        } else {
                                            None
                                        }
                                    } else {
                                        None
                                    }
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);

                    // ============ 获取 allowCommands ============
                    let allow_commands = data_compound
                        .get("allowCommands")
                        .map(|v| parse_bool_value(v))
                        .unwrap_or(false);

                    // ============ 获取游戏规则 ============
                    match data_compound.get("GameRules") {
                        Some(Value::Compound(game_rules)) => {
                            let keep_inventory = game_rules
                                .get("keepInventory")
                                .map(|v| parse_bool_value(v))
                                .unwrap_or(false);
                            let mob_griefing = game_rules
                                .get("mobGriefing")
                                .map(|v| parse_bool_value(v))
                                .unwrap_or(false);
                            let do_fire_tick = game_rules
                                .get("doFireTick")
                                .map(|v| parse_bool_value(v))
                                .unwrap_or(false);
                            
                            Some(vec![
                                seed_value.to_string(),
                                keep_inventory.to_string(),
                                mob_griefing.to_string(),
                                do_fire_tick.to_string(),
                                allow_commands.to_string(),
                            ])
                        }
                        _ => {
                            eprintln!("未找到 GameRules 节点");
                            Some(vec![
                                seed_value.to_string(),
                                "false".to_string(),
                                "false".to_string(),
                                "false".to_string(),
                                allow_commands.to_string(),
                            ])
                        }
                    }
                }
                _ => {
                    eprintln!("Data 节点不是 Compound 类型");
                    None
                }
            }
        }
        _ => {
            eprintln!("NBT 根节点不是 Compound 类型");
            None
        }
    };
    
    result
}

/// 修改 NBT 文件中的参数值
/// 参数：
///   - world_folder_abs_path: 世界文件夹的绝对路径
///   - param_name: 要修改的参数名
///   - new_value: 要修改成的值（支持 String, i64, bool 类型）
/// 返回：Result<(), String> 表示操作是否成功
pub fn modify_nbt_param(
    world_folder_abs_path: &str,
    param_name: &str,
    new_value: NBTValue,
) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::{Read, Write};

    let path = Path::new(world_folder_abs_path);
    let level_dat_path = path.join("level.dat");

    // 读取并解压文件
    let bytes = fs::read(&level_dat_path).map_err(|e| format!("读取文件失败: {}", e))?;

    let mut decoder = GzDecoder::new(&bytes[..]);
    let mut decompressed = Vec::new();
    decoder
        .read_to_end(&mut decompressed)
        .map_err(|_| "解压文件失败".to_string())?;

    // 解析 NBT 数据
    let mut nbt_value: Value =
        from_bytes(&decompressed).map_err(|e| format!("解析 NBT 数据失败: {:?}", e))?;

    // 递归查找并修改参数
    modify_value_recursive(&mut nbt_value, param_name, &new_value)?;

    // 序列化、压缩并写入文件
    let modified_bytes = to_bytes(&nbt_value).map_err(|e| format!("序列化失败: {:?}", e))?;

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(&modified_bytes)
        .map_err(|_| "压缩失败".to_string())?;

    let compressed = encoder
        .finish()
        .map_err(|e| format!("完成压缩失败: {}", e))?;

    fs::write(&level_dat_path, compressed).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(())
}

/// 修改 NBT 文件中的参数值（字符串版本）
/// 参数：
///   - world_folder_abs_path: 世界文件夹的绝对路径
///   - param_name: 要修改的参数名，仅支持：keepInventory、mobGriefing、doFireTick、allowCommands
///   - new_value: 要修改成的值（字符串类型，会自动转换为适当的NBT类型）
/// 返回：Result<(), String> 表示操作是否成功
pub fn modify_nbt_param_str(
    world_folder_abs_path: &str,
    param_name: &str,
    new_value: &str,
) -> Result<(), String> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    // 验证参数名是否合法（支持驼峰命名和下划线命名）
    let param_name_lower = param_name.to_lowercase().replace("_", "");
    if !matches!(
        param_name_lower.as_str(),
        "keepinventory" | "mobgriefing" | "dofiretick" | "allowcommands"
    ) {
        return Err(format!(
            "不支持的参数名: {}，仅支持: keepInventory, mobGriefing, doFireTick, allowCommands",
            param_name
        ));
    }

    let path = Path::new(world_folder_abs_path);
    let level_dat_path = path.join("level.dat");

    // 读取文件
    let bytes = fs::read(&level_dat_path).map_err(|e| format!("读取文件失败: {}", e))?;

    // 使用改进的解压函数（支持两种格式）
    let decompressed = decompress_level_dat(&bytes).map_err(|_| "解压文件失败".to_string())?;

    // 解析 NBT 数据
    let mut root: Value =
        from_bytes(&decompressed).map_err(|e| format!("解析 NBT 数据失败: {:?}", e))?;

    // 转换字符串值为适当的 NBT 类型
    // 注意：游戏规则(GameRules)中的布尔值存储为 String("true"/"false")
    //       allowCommands 存储为 Byte(0/1)
    let is_game_rule = matches!(
        param_name_lower.as_str(),
        "keepinventory" | "mobgriefing" | "dofiretick"
    );
    
    let value_to_set = if let Ok(b) = new_value.parse::<bool>() {
        if is_game_rule {
            // 游戏规则的布尔值存储为 NBT String
            Value::String(if b {
                "true".to_string()
            } else {
                "false".to_string()
            })
        } else {
            // allowCommands 等字段的布尔值存储为 NBT Byte
            Value::Byte(if b { 1 } else { 0 })
        }
    } else if let Ok(i) = new_value.parse::<i64>() {
        if i >= i8::MIN as i64 && i <= i8::MAX as i64 {
            Value::Byte(i as i8)
        } else if i >= i16::MIN as i64 && i <= i16::MAX as i64 {
            Value::Short(i as i16)
        } else if i >= i32::MIN as i64 && i <= i32::MAX as i64 {
            Value::Int(i as i32)
        } else {
            Value::Long(i)
        }
    } else if let Ok(f) = new_value.parse::<f64>() {
        Value::Double(f)
    } else {
        Value::String(new_value.to_string())
    };

    // 根据参数名修改对应的值
    if let Value::Compound(root_map) = &mut root {
        // 获取 Data 节点
        if let Some(Value::Compound(data_map)) = root_map.get_mut("Data") {
            // 处理游戏规则（keepInventory、mobGriefing、doFireTick）
            if matches!(
                param_name_lower.as_str(),
                "keepinventory" | "mobgriefing" | "dofiretick"
            ) {
                // 若 GameRules 不存在则自动创建
                if !data_map.contains_key("GameRules") {
                    data_map.insert("GameRules".to_string(), Value::Compound(HashMap::new()));
                }
                if let Some(Value::Compound(game_rules)) = data_map.get_mut("GameRules") {
                    // 优先查找已有的同名键（大小写和下划线可能不同），否则直接用标准名写入
                    let existing_key = game_rules
                        .keys()
                        .find(|k| k.to_lowercase().replace("_", "") == param_name_lower)
                        .cloned();
                    let key = existing_key.unwrap_or_else(|| param_name.to_string());
                    game_rules.insert(key, value_to_set);
                } else {
                    return Err("GameRules 节点类型不是 Compound".to_string());
                }
            }
            // 处理 allowCommands
            else if param_name_lower == "allowcommands" {
                // 查找已有键（大小写和下划线不敏感），若不存在则直接创建
                let existing_key = data_map
                    .keys()
                    .find(|k| k.to_lowercase().replace("_", "") == param_name_lower)
                    .cloned();
                let key = existing_key.unwrap_or_else(|| "allowCommands".to_string());
                data_map.insert(key, value_to_set);
            }
        } else {
            return Err("Data 节点不存在".to_string());
        }
    } else {
        return Err("NBT 数据格式错误".to_string());
    }

    // 序列化、压缩并写入文件
    let modified_bytes = to_bytes(&root).map_err(|e| format!("序列化失败: {:?}", e))?;

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(&modified_bytes)
        .map_err(|_| "压缩失败".to_string())?;

    let compressed = encoder
        .finish()
        .map_err(|e| format!("完成压缩失败: {}", e))?;

    fs::write(&level_dat_path, compressed).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(())
}

/// 递归查找并修改 NBT 值
fn modify_value_recursive(
    value: &mut Value,
    param_name: &str,
    new_value: &NBTValue,
) -> Result<(), String> {
    match value {
        Value::Compound(map) => {
            // 检查当前 Compound 是否包含目标参数
            if map.contains_key(param_name) {
                map.insert(param_name.to_string(), new_value.to_value());
                return Ok(());
            }
            // 递归查找子 Compound
            for (_, v) in map.iter_mut() {
                if let Err(e) = modify_value_recursive(v, param_name, new_value) {
                    if e != "参数未找到" {
                        return Err(e);
                    }
                } else {
                    return Ok(());
                }
            }
            Err("参数未找到".to_string())
        }
        Value::List(list) => {
            // 递归查找 List 中的元素
            for v in list.iter_mut() {
                if let Err(e) = modify_value_recursive(v, param_name, new_value) {
                    if e != "参数未找到" {
                        return Err(e);
                    }
                } else {
                    return Ok(());
                }
            }
            Err("参数未找到".to_string())
        }
        _ => Err("参数未找到".to_string()),
    }
}

/// NBT 值的枚举类型
#[derive(Debug, Clone)]
pub enum NBTValue {
    String(String),
    Int(i32),
    Long(i64),
    Short(i16),
    Byte(i8),
    Float(f32),
    Double(f64),
    Bool(bool),
}

impl NBTValue {
    fn to_value(&self) -> Value {
        match self {
            NBTValue::String(s) => Value::String(s.clone()),
            NBTValue::Int(i) => Value::Int(*i),
            NBTValue::Long(l) => Value::Long(*l),
            NBTValue::Short(s) => Value::Short(*s),
            NBTValue::Byte(b) => Value::Byte(*b),
            NBTValue::Float(f) => Value::Float(*f),
            NBTValue::Double(d) => Value::Double(*d),
            NBTValue::Bool(b) => Value::Byte(if *b { 1 } else { 0 }),
        }
    }
}