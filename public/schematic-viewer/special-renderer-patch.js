/**
 * Patch DeepSlate SpecialRenderers for modern (26.2+) assets:
 * - Beds / signs / banners: skip special meshes (missing entity/* atlas → black cubes).
 * - Double chests: type=left|right → opposite half mesh+texture (DeepSlate facing yaw
 *   mirrors model X vs Minecraft chest type), 15-wide seam-flush geometry, and
 *   horizontally flipped front/back/top UVs so outer borders stay outside.
 *   Final 1/16 scale matches DeepSlate getBlockMesh. Single/ender unchanged.
 *
 * Patch revision: 9 (unflip top/bottom UVs)
 */
(function () {
  if (typeof deepslate === "undefined" || !deepslate.SpecialRenderers) {
    console.warn("[schematic-viewer] special-renderer-patch: deepslate not ready");
    return;
  }

  var SR = deepslate.SpecialRenderers;
  if (typeof SR.getBlockMesh !== "function") return;

  if (!SR.__oxlOrigGetBlockMesh) {
    SR.__oxlOrigGetBlockMesh = SR.getBlockMesh.bind(SR);
  }
  var origGetBlockMesh = SR.__oxlOrigGetBlockMesh;
  var Mesh = deepslate.Mesh;
  var BlockModel = deepslate.BlockModel;
  var Cull = deepslate.Cull;
  var Identifier = deepslate.Identifier;

  function emptyMesh() {
    return new Mesh();
  }

  function shouldUseBlockModelOnly(name) {
    return (
      /_bed$/.test(name) ||
      /_sign$/.test(name) ||
      /_hanging_sign$/.test(name) ||
      /_wall_sign$/.test(name) ||
      /_wall_hanging_sign$/.test(name) ||
      /_banner$/.test(name) ||
      /_wall_banner$/.test(name)
    );
  }

  var DOUBLE_CHEST_BASE = {
    "minecraft:chest": "normal",
    "minecraft:trapped_chest": "trapped",
    "minecraft:copper_chest": "copper",
    "minecraft:exposed_copper_chest": "copper_exposed",
    "minecraft:weathered_copper_chest": "copper_weathered",
    "minecraft:oxidized_copper_chest": "copper_oxidized",
    "minecraft:waxed_copper_chest": "copper",
    "minecraft:waxed_exposed_copper_chest": "copper_exposed",
    "minecraft:waxed_weathered_copper_chest": "copper_weathered",
    "minecraft:waxed_oxidized_copper_chest": "copper_oxidized",
  };

  /**
   * Minecraft ChestModel halves in DeepSlate closed-lid style.
   * right: x=1..16 ; left: x=0..15 ; latch on the shared edge.
   * Front/back U flipped (north/south); top/bottom keep natural U direction
   * so outer borders stay on the outside after half invert + facing yaw.
   * Width UV = 15/4 = 3.75 → spans end at 11 (not 10.75).
   */
  function doubleChestHalfElements(half) {
    var isRight = half === "right";
    var x0 = isRight ? 1 : 0;
    var x1 = isRight ? 16 : 15;
    var lx0 = isRight ? 15 : 0;
    var lx1 = isRight ? 16 : 1;

    var body = {
      north: { uv: [14.5, 8.25, 10.75, 10.75], rotation: 180, texture: "#0" },
      east: { uv: [7.25, 8.25, 10.75, 10.75], rotation: 180, texture: "#0" },
      south: { uv: [7.25, 8.25, 3.5, 10.75], rotation: 180, texture: "#0" },
      west: { uv: [0, 8.25, 3.5, 10.75], rotation: 180, texture: "#0" },
      up: { uv: [7.25, 4.75, 11, 8.25], texture: "#0" },
      down: { uv: [3.5, 4.75, 7.25, 8.25], texture: "#0" },
    };
    var lid = {
      north: { uv: [14.5, 3.75, 10.75, 4.75], rotation: 180, texture: "#0" },
      east: { uv: [7.25, 3.75, 10.75, 4.75], rotation: 180, texture: "#0" },
      south: { uv: [7.25, 3.75, 3.5, 4.75], rotation: 180, texture: "#0" },
      west: { uv: [0, 3.75, 3.5, 4.75], rotation: 180, texture: "#0" },
      up: { uv: [7.25, 0, 11, 3.5], texture: "#0" },
      down: { uv: [3.5, 0, 7.25, 3.5], texture: "#0" },
    };

    if (isRight) {
      delete body.east;
      delete lid.east;
    } else {
      delete body.west;
      delete lid.west;
    }

    return [
      { from: [x0, 0, 1], to: [x1, 10, 15], faces: body },
      { from: [x0, 10, 1], to: [x1, 14, 15], faces: lid },
      {
        from: [lx0, 7, 0],
        to: [lx1, 11, 2],
        faces: {
          north: { uv: [0.5, 0.25, 0.25, 1.25], rotation: 180, texture: "#0" },
          east: { uv: [0, 0.25, 0.25, 1.25], rotation: 180, texture: "#0" },
          south: { uv: [0.75, 0.25, 0.5, 1.25], rotation: 180, texture: "#0" },
          west: { uv: [0.75, 0.25, 1, 1.25], rotation: 180, texture: "#0" },
          up: { uv: [0.5, 0, 0.25, 0.25], rotation: 180, texture: "#0" },
          down: { uv: [0.75, 0, 0.5, 0.25], rotation: 180, texture: "#0" },
        },
      },
    ];
  }

  function facingYaw(facing) {
    if (facing === "west") return Math.PI / 2;
    if (facing === "south") return Math.PI;
    if (facing === "east") return (Math.PI * 3) / 2;
    return 0;
  }

  function facingMatrix(facing) {
    var yaw = facingYaw(facing);
    var c = Math.cos(yaw);
    var s = Math.sin(yaw);
    var tx = 8 - 8 * c - 8 * s;
    var ty = 0;
    var tz = 8 + 8 * s - 8 * c;
    return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1]);
  }

  var BLOCK_SCALE = new Float32Array([0.0625, 0, 0, 0, 0, 0.0625, 0, 0, 0, 0, 0.0625, 0, 0, 0, 0, 1]);

  function chestTextureId(baseTex, half) {
    if (Identifier && typeof Identifier.create === "function") {
      try {
        return Identifier.create(baseTex + "_" + half).withPrefix("entity/chest/").toString();
      } catch (e) {}
    }
    return "minecraft:entity/chest/" + baseTex + "_" + half;
  }

  function renderDoubleChestHalf(block, atlas, baseTex, typeHalf) {
    if (!BlockModel || !Cull) return null;

    var props = typeof block.getProperties === "function" ? block.getProperties() : {};
    var facing = (props && props.facing) || "south";
    // Facing yaw mirrors local X vs ChestType, so swap which half mesh/texture we use.
    var half = typeHalf === "left" ? "right" : "left";

    var mesh = new BlockModel(
      undefined,
      { 0: chestTextureId(baseTex, half) },
      doubleChestHalfElements(half),
    ).getMesh(atlas, Cull.none());

    mesh.transform(facingMatrix(facing));
    mesh.transform(BLOCK_SCALE);
    return mesh;
  }

  SR.getBlockMesh = function (block, nbt, atlas, cull) {
    try {
      var name = block.getName().toString();
      if (shouldUseBlockModelOnly(name)) {
        return emptyMesh();
      }

      var base = DOUBLE_CHEST_BASE[name];
      if (base) {
        var props = typeof block.getProperties === "function" ? block.getProperties() : {};
        var type = (props && props.type) || "single";
        if (type === "left" || type === "right") {
          var halfMesh = renderDoubleChestHalf(block, atlas, base, type);
          if (halfMesh) return halfMesh;
        }
      }
    } catch (e) {
      console.warn("[schematic-viewer] special-renderer-patch error:", e);
    }
    return origGetBlockMesh(block, nbt, atlas, cull);
  };

  SR.__oxlPatched = true;
  SR.__oxlPatchRev = 9;
  console.log("[schematic-viewer] SpecialRenderers patched rev=9 (top/bottom UV unflip)");
})();
