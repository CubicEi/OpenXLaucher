// WorldEdit / Sponge .schem and classic .schematic → Litematic-shaped model for the viewer.

function schematicParseBlockState(stateStr) {
  var base = stateStr;
  var props = null;
  var bracket = stateStr.indexOf("[");
  if (bracket >= 0) {
    base = stateStr.slice(0, bracket);
    var close = stateStr.lastIndexOf("]");
    if (close > bracket) {
      props = {};
      var inner = stateStr.slice(bracket + 1, close);
      inner.split(",").forEach(function (part) {
        var kv = part.split("=");
        if (kv.length === 2) {
          props[kv[0].trim()] = kv[1].trim();
        }
      });
    }
  }
  if (base.indexOf(":") < 0) {
    base = "minecraft:" + base;
  }
  var entry = { Name: base };
  if (props && Object.keys(props).length > 0) {
    entry.Properties = props;
  }
  return entry;
}

function readVarIntBlockIds(byteValues) {
  var ids = [];
  var i = 0;
  while (i < byteValues.length) {
    var value = 0;
    var shift = 0;
    var b;
    do {
      if (i >= byteValues.length) break;
      b = byteValues[i++];
      value |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    ids.push(value >>> 0);
  }
  return ids;
}

function spongePaletteToList(paletteCompound) {
  var maxId = -1;
  var map = {};
  for (var key in paletteCompound) {
    var id = paletteCompound[key];
    if (id && typeof id === "object" && id.hasOwnProperty("value")) {
      id = id.value;
    }
    map[id] = schematicParseBlockState(key);
    if (id > maxId) maxId = id;
  }
  var list = new Array(maxId + 1);
  for (var idKey in map) {
    list[parseInt(idKey, 10)] = map[idKey];
  }
  list[0] = list[0] || { Name: "minecraft:air" };
  return list;
}

function buildBlocksArray(width, height, length, blockIds) {
  var blocks = new Array(width);
  for (var x = 0; x < width; x++) {
    blocks[x] = new Array(height);
    for (var y = 0; y < height; y++) {
      blocks[x][y] = new Array(length);
      for (var z = 0; z < length; z++) {
        var index = (y * length + z) * width + x;
        blocks[x][y][z] = index < blockIds.length ? blockIds[index] : 0;
      }
    }
  }
  return blocks;
}

var LEGACY_BLOCK_IDS = {
  0: "minecraft:air",
  1: "minecraft:stone",
  2: "minecraft:grass_block",
  3: "minecraft:dirt",
  4: "minecraft:cobblestone",
  5: "minecraft:oak_planks",
  7: "minecraft:bedrock",
  12: "minecraft:sand",
  13: "minecraft:gravel",
  17: "minecraft:oak_log",
  18: "minecraft:oak_leaves",
  20: "minecraft:glass",
  35: "minecraft:white_wool",
  41: "minecraft:gold_block",
  42: "minecraft:iron_block",
  45: "minecraft:bricks",
  47: "minecraft:bookshelf",
  49: "minecraft:obsidian",
  56: "minecraft:diamond_block",
  57: "minecraft:diamond_block",
  79: "minecraft:ice",
  80: "minecraft:snow_block",
  88: "minecraft:netherrack",
  89: "minecraft:glowstone",
  98: "minecraft:stone_bricks",
};

function legacyIdToBlock(id, data) {
  var name = LEGACY_BLOCK_IDS[id];
  if (!name) {
    name = "minecraft:stone";
  }
  var entry = { Name: name };
  if (data > 0 && id === 35) {
    entry.Properties = { color: String(data) };
  }
  return entry;
}

function classicSchematicPalette(blockBytes, dataBytes) {
  var palette = [{ Name: "minecraft:air" }];
  var paletteIndex = {};
  var blockIds = [];

  for (var i = 0; i < blockBytes.length; i++) {
    var bid = blockBytes[i] & 0xff;
    var data = dataBytes && i < dataBytes.length ? dataBytes[i] & 0xff : 0;
    var key = bid + ":" + data;
    if (bid === 0) {
      blockIds.push(0);
      continue;
    }
    if (!paletteIndex.hasOwnProperty(key)) {
      paletteIndex[key] = palette.length;
      palette.push(legacyIdToBlock(bid, data));
    }
    blockIds.push(paletteIndex[key]);
  }

  return { blockPalette: palette, linearIds: blockIds };
}

function wrapAsLitematic(width, height, length, blocks, blockPalette, regionName) {
  var region = new LitematicRegion(width, height, length);
  region.blocks = blocks;
  region.blockPalette = blockPalette;
  region.name = regionName || "schematic";
  region.position = { x: 0, y: 0, z: 0 };

  var litematic = new Litematic();
  litematic.regions = [region];
  litematic.regionNames = [region.name];
  return litematic;
}

function detectSchematicFormat(root) {
  if (root.Regions && root.Regions.value) return "litematic";
  if (root.Palette && root.BlockData) return "sponge";
  if (root.Blocks && root.Width) return "classic";
  return "unknown";
}

function readSpongeSchematicFromNBT(nbtdata) {
  var root = nbtdata.value;
  var width = root.Width.value;
  var height = root.Height.value;
  var length = root.Length.value;

  var paletteRaw = __stripNBTTyping(root.Palette);
  var blockPalette = spongePaletteToList(paletteRaw);

  var dataRaw = root.BlockData ? root.BlockData.value : root.Data.value;
  var bytes;
  if (Array.isArray(dataRaw) && dataRaw.length > 0 && Array.isArray(dataRaw[0])) {
    bytes = dataRaw;
  } else if (dataRaw && dataRaw.value) {
    bytes = dataRaw.value;
  } else {
    bytes = dataRaw;
  }

  var blockIds = readVarIntBlockIds(bytes);
  var blocks = buildBlocksArray(width, height, length, blockIds);
  return wrapAsLitematic(width, height, length, blocks, blockPalette, "schem");
}

function readClassicSchematicFromNBT(nbtdata) {
  var root = nbtdata.value;
  var width = root.Width.value;
  var height = root.Height.value;
  var length = root.Length.value;

  var blockBytes = root.Blocks.value;
  var dataBytes = root.Data ? root.Data.value : null;
  var parsed = classicSchematicPalette(blockBytes, dataBytes);
  var blocks = buildBlocksArray(width, height, length, parsed.linearIds);
  return wrapAsLitematic(width, height, length, blocks, parsed.blockPalette, "schematic");
}

function readSchematicFromNBTData(nbtdata) {
  var fmt = detectSchematicFormat(nbtdata.value);
  if (fmt === "sponge") {
    return readSpongeSchematicFromNBT(nbtdata);
  }
  if (fmt === "classic") {
    return readClassicSchematicFromNBT(nbtdata);
  }
  throw new Error("Unsupported schematic format (expected .schem Sponge or classic .schematic)");
}

function parseSchematicBufferToLitematic(nbtdata, fileName) {
  var fmt = detectSchematicFormat(nbtdata.value);
  if (fmt === "litematic") {
    return { litematic: readLitematicFromNBTData(nbtdata), format: "litematic" };
  }
  var ext = (fileName || "").split(".").pop().toLowerCase();
  if (fmt === "sponge" || ext === "schem") {
    return { litematic: readSpongeSchematicFromNBT(nbtdata), format: "sponge" };
  }
  if (fmt === "classic" || ext === "schematic") {
    return { litematic: readClassicSchematicFromNBT(nbtdata), format: "classic" };
  }
  if (ext === "litematic") {
    return { litematic: readLitematicFromNBTData(nbtdata), format: "litematic" };
  }
  try {
    return { litematic: readLitematicFromNBTData(nbtdata), format: "litematic" };
  } catch (e1) {
    try {
      return { litematic: readSchematicFromNBTData(nbtdata), format: "schematic" };
    } catch (e2) {
      throw new Error(
        "Could not parse file as litematic or schematic.\n" +
          (e2 instanceof Error ? e2.message : String(e2))
      );
    }
  }
}
