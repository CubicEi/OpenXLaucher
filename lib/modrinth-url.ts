/** Modrinth 站内项目页路径段（与 API `project_type` / 搜索分类不一定一致）。 */
export function modrinthSitePathSegment(projectType: string | undefined): string {
  const lower = (projectType || "mod").toLowerCase().trim();
  const map: Record<string, string> = {
    mod: "mod",
    modpack: "modpack",
    resourcepack: "resourcepack",
    "resource pack": "resourcepack",
    shader: "shader",
    shaders: "shader",
    shaderpack: "shader",
    "shader pack": "shader",
    datapack: "datapack",
    "data pack": "datapack",
    world: "world",
    worlds: "world",
    plugin: "plugin",
  };
  return map[lower] ?? lower.replace(/\s+/g, "");
}

export function modrinthProjectPageUrl(slug: string, projectType: string | undefined): string {
  return `https://modrinth.com/${modrinthSitePathSegment(projectType)}/${slug.trim()}`;
}
