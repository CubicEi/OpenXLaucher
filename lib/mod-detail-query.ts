export type ModDetailSource = "modrinth" | "curseforge" | "both" | string;

export type ModDetailProjectQuery = {
  mod: string;
  source?: ModDetailSource | null;
  mrProjectId?: string | null;
  cfProjectId?: string | null;
};

export function appendResolvedModDetailIds(
  params: URLSearchParams,
  target: {
    slug: string;
    source?: string | null;
    projectId?: string | null;
  },
): void {
  params.set("mod", target.slug);
  const source = (target.source || "").trim().toLowerCase();
  if (source) params.set("source", source);
  const projectId = target.projectId?.trim();
  if (!projectId) return;
  if (source === "curseforge") {
    params.set("cfProjectId", projectId);
  } else {
    params.set("mrProjectId", projectId);
  }
}

export function buildModDetailSearchParams(
  slug: string,
  opts?: {
    source?: ModDetailSource;
    modrinthProjectId?: string | null;
    curseforgeProjectId?: number | null;
    returnTo?: string;
    query?: string;
    category?: string;
    forceType?: string;
  },
): URLSearchParams {
  const params = new URLSearchParams({ mod: slug });
  if (opts?.source) params.set("source", opts.source);
  if (opts?.modrinthProjectId?.trim()) {
    params.set("mrProjectId", opts.modrinthProjectId.trim());
  }
  if (opts?.curseforgeProjectId != null && opts.curseforgeProjectId > 0) {
    params.set("cfProjectId", String(opts.curseforgeProjectId));
  }
  if (opts?.returnTo) params.set("returnTo", opts.returnTo);
  if (opts?.query !== undefined) params.set("query", opts.query);
  if (opts?.category) params.set("category", opts.category);
  if (opts?.forceType) params.set("forceType", opts.forceType);
  return params;
}

export function parseModDetailProjectQuery(search: string): ModDetailProjectQuery {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    mod: params.get("mod") || "",
    source: params.get("source"),
    mrProjectId: params.get("mrProjectId"),
    cfProjectId: params.get("cfProjectId"),
  };
}
