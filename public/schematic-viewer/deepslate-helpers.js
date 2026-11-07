var deepslateResources;

function upperPowerOfTwo(x) {
  x -= 1;
  x |= x >> 1;
  x |= x >> 2;
  x |= x >> 4;
  x |= x >> 8;
  x |= x >> 16;
  return x + 1;
}

// Load Deepslate resources from texture atlas image (deepslate 0.27+ / mcmeta assets).
function loadDeepslateResources(textureImage) {
  console.log("[schematic-viewer] loading resources...");
  var blockDefinitions = {};
  Object.keys(assets.blockstates).forEach(function (id) {
    blockDefinitions["minecraft:" + id] = deepslate.BlockDefinition.fromJson(assets.blockstates[id]);
  });

  var blockModels = {};
  Object.keys(assets.models).forEach(function (id) {
    blockModels["minecraft:" + id] = deepslate.BlockModel.fromJson(assets.models[id]);
  });
  Object.values(blockModels).forEach(function (m) {
    m.flatten({
      getBlockModel: function (id) {
        return blockModels[id.toString()] || null;
      },
    });
  });

  var atlasSize = upperPowerOfTwo(
    textureImage.width >= textureImage.height ? textureImage.width : textureImage.height,
  );
  var atlasCanvas = document.createElement("canvas");
  atlasCanvas.width = atlasSize;
  atlasCanvas.height = atlasSize;

  var atlasCtx = atlasCanvas.getContext("2d");
  atlasCtx.drawImage(textureImage, 0, 0);

  var atlasData = atlasCtx.getImageData(0, 0, atlasSize, atlasSize);
  var idMap = {};

  Object.keys(assets.textures).forEach(function (id) {
    var uv = assets.textures[id];
    var u = uv[0];
    var v = uv[1];
    var du = uv[2];
    var dv = uv[3];
    var dv2 = du !== dv && id.startsWith("block/") ? du : dv;
    idMap["minecraft:" + id] = [
      u / atlasSize,
      v / atlasSize,
      (u + du) / atlasSize,
      (v + dv2) / atlasSize,
    ];
  });

  var textureAtlas = new deepslate.TextureAtlas(atlasData, idMap);

  deepslateResources = {
    getBlockDefinition: function (id) {
      return blockDefinitions[id.toString()] || null;
    },
    getBlockModel: function (id) {
      return blockModels[id.toString()] || null;
    },
    getTextureUV: function (id) {
      return textureAtlas.getTextureUV(id);
    },
    getTextureAtlas: function () {
      return textureAtlas.getTextureAtlas();
    },
    getPixelSize: function () {
      return typeof textureAtlas.getPixelSize === "function" ? textureAtlas.getPixelSize() : 1 / atlasSize;
    },
    getBlockFlags: function (id) {
      var key = id.toString();
      return {
        opaque: typeof OPAQUE_BLOCKS !== "undefined" && OPAQUE_BLOCKS.has(key),
        self_culling: typeof NON_SELF_CULLING === "undefined" || !NON_SELF_CULLING.has(key),
        semi_transparent: typeof TRANSPARENT_BLOCKS !== "undefined" && TRANSPARENT_BLOCKS.has(key),
      };
    },
    getBlockProperties: function () {
      return null;
    },
    getDefaultBlockProperties: function () {
      return null;
    },
  };

  return deepslateResources;
}

/** Above this cell count: smaller work slices + larger mesh chunks. */
var SCHEMATIC_HEAVY_VOLUME = 64 * 64 * 64; // ~262k
/**
 * Hard volume cap (width*height*depth of the preview box). Beyond this, WebGL mesh
 * baking often OOMs and blanks the Tauri webview.
 */
var SCHEMATIC_MAX_VOLUME = 128 * 128 * 128; // ~2.1M cells

function yieldToMain() {
  return new Promise(function (resolve) {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(function () {
        setTimeout(resolve, 0);
      });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function estimateLitematicVolume(litematic, y_min, y_max, regionIndex) {
  if (regionIndex === undefined || regionIndex === null || regionIndex < 0) {
    var bounds = litematicRegionBounds(litematic);
    var sizeY = Math.max(1, bounds.maxY - bounds.minY);
    var y0 = y_min || 0;
    var y1 = y_max == null || y_max < 0 ? sizeY : Math.min(y_max, sizeY);
    return Math.max(1, bounds.maxX - bounds.minX) * Math.max(1, y1 - y0) * Math.max(1, bounds.maxZ - bounds.minZ);
  }
  var region = litematic.regions[regionIndex] || litematic.regions[0];
  var size = regionPositiveSize(region);
  var yy0 = y_min || 0;
  var yy1 = y_max == null || y_max < 0 ? size.y : Math.min(y_max, size.y);
  return size.x * Math.max(1, yy1 - yy0) * size.z;
}

function addRegionBlocksToStructure(structure, region, y_min, y_max, originX, originY, originZ) {
  // Sync fallback for tiny regions
  var state = { x: 0, y: y_min, z: 0, done: false };
  while (!state.done) {
    addRegionBlocksSlice(structure, region, y_min, y_max, originX, originY, originZ, state, 1e12);
  }
}

/**
 * Process a time-budgeted slice of blocks. Mutates `state` ({x,y,z,done}).
 * Returns number of cells visited.
 */
function addRegionBlocksSlice(structure, region, y_min, y_max, originX, originY, originZ, state, cellBudget) {
  var blocks = region.blocks;
  var blockPalette = region.blockPalette;
  var width = blocks.length;
  var depth = blocks[0][0].length;
  var visited = 0;
  var x = state.x;
  var y = state.y;
  var z = state.z;

  for (; x < width; x++) {
    for (; y < y_max; y++) {
      for (; z < depth; z++) {
        var blockID = blocks[x][y][z];
        if (blockID > 0) {
          if (blockID < blockPalette.length) {
            var blockInfo = blockPalette[blockID];
            var wx = x + originX;
            var wy = y + originY;
            var wz = z + originZ;
            if (blockInfo.hasOwnProperty("Properties")) {
              structure.addBlock([wx, wy, wz], blockInfo.Name, blockInfo.Properties);
            } else {
              structure.addBlock([wx, wy, wz], blockInfo.Name);
            }
          } else {
            structure.addBlock([x + originX, y + originY, z + originZ], "minecraft:cake");
          }
        }
        visited++;
        if (visited >= cellBudget) {
          state.x = x;
          state.y = y;
          state.z = z + 1;
          if (state.z >= depth) {
            state.z = 0;
            state.y++;
            if (state.y >= y_max) {
              state.y = y_min;
              state.x++;
            }
          }
          state.done = state.x >= width;
          return visited;
        }
      }
      z = 0;
    }
    y = y_min;
  }
  state.x = width;
  state.y = y_min;
  state.z = 0;
  state.done = true;
  return visited;
}

async function addRegionBlocksToStructureAsync(
  structure,
  region,
  y_min,
  y_max,
  originX,
  originY,
  originZ,
  onProgress,
) {
  var size = regionPositiveSize(region);
  var total = size.x * Math.max(1, y_max - y_min) * size.z;
  var state = { x: 0, y: y_min, z: 0, done: false };
  var doneCells = 0;
  var budget = total > SCHEMATIC_HEAVY_VOLUME ? 12000 : 60000;

  while (!state.done) {
    doneCells += addRegionBlocksSlice(
      structure,
      region,
      y_min,
      y_max,
      originX,
      originY,
      originZ,
      state,
      budget,
    );
    if (typeof onProgress === "function") {
      onProgress(Math.min(1, doneCells / Math.max(1, total)));
    }
    if (!state.done) {
      await yieldToMain();
    }
  }
}

function regionPositiveSize(region) {
  var blocks = region.blocks;
  if (blocks && blocks.length && blocks[0] && blocks[0][0]) {
    return {
      x: blocks.length,
      y: blocks[0].length,
      z: blocks[0][0].length,
    };
  }
  return {
    x: Math.abs(region.width || 0),
    y: Math.abs(region.height || 0),
    z: Math.abs(region.depth || 0),
  };
}

function litematicRegionBounds(litematic) {
  var minX = 0,
    minY = 0,
    minZ = 0;
  var maxX = 0,
    maxY = 0,
    maxZ = 0;
  var first = true;
  for (var i = 0; i < litematic.regions.length; i++) {
    var region = litematic.regions[i];
    var size = regionPositiveSize(region);
    var px = region.position ? region.position.x : 0;
    var py = region.position ? region.position.y : 0;
    var pz = region.position ? region.position.z : 0;
    var x0 = px;
    var y0 = py;
    var z0 = pz;
    var x1 = px + size.x;
    var y1 = py + size.y;
    var z1 = pz + size.z;
    if (first) {
      minX = Math.min(x0, x1);
      minY = Math.min(y0, y1);
      minZ = Math.min(z0, z1);
      maxX = Math.max(x0, x1);
      maxY = Math.max(y0, y1);
      maxZ = Math.max(z0, z1);
      first = false;
    } else {
      minX = Math.min(minX, x0, x1);
      minY = Math.min(minY, y0, y1);
      minZ = Math.min(minZ, z0, z1);
      maxX = Math.max(maxX, x0, x1);
      maxY = Math.max(maxY, y0, y1);
      maxZ = Math.max(maxZ, z0, z1);
    }
  }
  return { minX: minX, minY: minY, minZ: minZ, maxX: maxX, maxY: maxY, maxZ: maxZ };
}

function assertStructureVolumeOk(volume) {
  if (volume > SCHEMATIC_MAX_VOLUME) {
    throw new Error(
      "投影体积过大（约 " +
        volume.toLocaleString() +
        " 格），预览上限 " +
        SCHEMATIC_MAX_VOLUME.toLocaleString() +
        " 格。请改用更小区域，或在设置中只显示部分层。 / Schematic too large (~" +
        volume.toLocaleString() +
        " cells; max " +
        SCHEMATIC_MAX_VOLUME.toLocaleString() +
        "). Use a smaller region or fewer layers.",
    );
  }
}

function structureFromLitematic(litematic, y_min, y_max, regionIndex) {
  // Sync path kept for compatibility; prefer structureFromLitematicAsync.
  if (y_min === undefined) y_min = 0;
  if (y_max === undefined) y_max = -1;
  assertStructureVolumeOk(estimateLitematicVolume(litematic, y_min, y_max, regionIndex));
  if (regionIndex === undefined || regionIndex === null || regionIndex < 0) {
    return structureFromLitematicMergedSync(litematic, y_min, y_max);
  }
  var region = litematic.regions[regionIndex] || litematic.regions[0];
  var size = regionPositiveSize(region);
  var height = size.y;
  if (y_max == -1) y_max = height;
  y_max = Math.min(y_max, height);
  var structure = new deepslate.Structure([size.x, size.y, size.z]);
  addRegionBlocksToStructure(structure, region, y_min, y_max, 0, 0, 0);
  return structure;
}

function structureFromLitematicMergedSync(litematic, y_min, y_max) {
  var bounds = litematicRegionBounds(litematic);
  var sizeX = Math.max(1, bounds.maxX - bounds.minX);
  var sizeY = Math.max(1, bounds.maxY - bounds.minY);
  var sizeZ = Math.max(1, bounds.maxZ - bounds.minZ);
  if (y_max == -1) y_max = sizeY;
  y_max = Math.min(y_max, sizeY);
  var structure = new deepslate.Structure([sizeX, sizeY, sizeZ]);
  for (var i = 0; i < litematic.regions.length; i++) {
    var region = litematic.regions[i];
    var size = regionPositiveSize(region);
    var px = (region.position ? region.position.x : 0) - bounds.minX;
    var py = (region.position ? region.position.y : 0) - bounds.minY;
    var pz = (region.position ? region.position.z : 0) - bounds.minZ;
    var localYMax = Math.min(y_max - py, size.y);
    if (localYMax <= y_min) continue;
    addRegionBlocksToStructure(structure, region, Math.max(0, y_min - py), localYMax, px, py, pz);
  }
  return structure;
}

async function structureFromLitematicAsync(litematic, y_min, y_max, regionIndex, onProgress) {
  if (y_min === undefined) y_min = 0;
  if (y_max === undefined) y_max = -1;
  var volume = estimateLitematicVolume(litematic, y_min, y_max, regionIndex);
  assertStructureVolumeOk(volume);

  if (regionIndex === undefined || regionIndex === null || regionIndex < 0) {
    return structureFromLitematicMergedAsync(litematic, y_min, y_max, onProgress);
  }

  var region = litematic.regions[regionIndex] || litematic.regions[0];
  var size = regionPositiveSize(region);
  var height = size.y;
  if (y_max == -1) y_max = height;
  y_max = Math.min(y_max, height);
  var structure = new deepslate.Structure([size.x, size.y, size.z]);
  console.log("[schematic-viewer] Building blocks (single region, async)...", size);
  await addRegionBlocksToStructureAsync(structure, region, y_min, y_max, 0, 0, 0, onProgress);
  return structure;
}

async function structureFromLitematicMergedAsync(litematic, y_min, y_max, onProgress) {
  var bounds = litematicRegionBounds(litematic);
  var sizeX = Math.max(1, bounds.maxX - bounds.minX);
  var sizeY = Math.max(1, bounds.maxY - bounds.minY);
  var sizeZ = Math.max(1, bounds.maxZ - bounds.minZ);
  if (y_max == -1) y_max = sizeY;
  y_max = Math.min(y_max, sizeY);
  var structure = new deepslate.Structure([sizeX, sizeY, sizeZ]);
  console.log("[schematic-viewer] Building blocks (merged, async)...", sizeX, sizeY, sizeZ);

  var regionCount = litematic.regions.length;
  for (var i = 0; i < regionCount; i++) {
    var region = litematic.regions[i];
    var size = regionPositiveSize(region);
    var px = (region.position ? region.position.x : 0) - bounds.minX;
    var py = (region.position ? region.position.y : 0) - bounds.minY;
    var pz = (region.position ? region.position.z : 0) - bounds.minZ;
    var localYMax = Math.min(y_max - py, size.y);
    if (localYMax <= y_min) continue;
    var base = i / regionCount;
    var span = 1 / regionCount;
    await addRegionBlocksToStructureAsync(
      structure,
      region,
      Math.max(0, y_min - py),
      localYMax,
      px,
      py,
      pz,
      function (p) {
        if (typeof onProgress === "function") onProgress(base + p * span);
      },
    );
  }
  return structure;
}
