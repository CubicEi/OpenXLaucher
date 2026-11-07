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

function addRegionBlocksToStructure(structure, region, y_min, y_max, originX, originY, originZ) {
  var blocks = region.blocks;
  var blockPalette = region.blockPalette;
  var width = blocks.length;
  var height = blocks[0].length;
  var depth = blocks[0][0].length;

  for (var x = 0; x < width; x++) {
    for (var y = y_min; y < y_max; y++) {
      for (var z = 0; z < depth; z++) {
        var blockID = blocks[x][y][z];
        if (blockID > 0) {
          if (blockID < blockPalette.length) {
            var blockInfo = blockPalette[blockID];
            var blockName = blockInfo.Name;
            var wx = x + originX;
            var wy = y + originY;
            var wz = z + originZ;
            if (blockInfo.hasOwnProperty("Properties")) {
              structure.addBlock([wx, wy, wz], blockName, blockInfo.Properties);
            } else {
              structure.addBlock([wx, wy, wz], blockName);
            }
          } else {
            structure.addBlock([x + originX, y + originY, z + originZ], "minecraft:cake");
          }
        }
      }
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

function structureFromLitematic(litematic, y_min, y_max, regionIndex) {
  if (y_min === undefined) y_min = 0;
  if (y_max === undefined) y_max = -1;
  if (regionIndex === undefined || regionIndex === null || regionIndex < 0) {
    return structureFromLitematicMerged(litematic, y_min, y_max);
  }
  var region = litematic.regions[regionIndex];
  if (!region) {
    region = litematic.regions[0];
  }
  var size = regionPositiveSize(region);
  var height = size.y;
  if (y_max == -1) {
    y_max = height;
  }
  y_max = Math.min(y_max, height);

  var structure = new deepslate.Structure([size.x, size.y, size.z]);
  console.log("[schematic-viewer] Building blocks (single region)...", size);
  addRegionBlocksToStructure(structure, region, y_min, y_max, 0, 0, 0);
  return structure;
}

function structureFromLitematicMerged(litematic, y_min, y_max) {
  if (y_min === undefined) y_min = 0;
  if (y_max === undefined) y_max = -1;
  var bounds = litematicRegionBounds(litematic);
  var sizeX = Math.max(1, bounds.maxX - bounds.minX);
  var sizeY = Math.max(1, bounds.maxY - bounds.minY);
  var sizeZ = Math.max(1, bounds.maxZ - bounds.minZ);
  if (y_max == -1) {
    y_max = sizeY;
  }
  y_max = Math.min(y_max, sizeY);

  var structure = new deepslate.Structure([sizeX, sizeY, sizeZ]);
  console.log("[schematic-viewer] Building blocks (merged regions)...", sizeX, sizeY, sizeZ);
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
