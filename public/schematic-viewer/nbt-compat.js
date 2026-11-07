/**
 * deepslate >= 0.20 removed readNbt(); expose a shim that returns the old
 * NamedNbtTag shape ({ name, value }) expected by litematic-utils / schematic-format-utils.
 */
(function () {
  var TYPE_NAMES = [
    "end",
    "byte",
    "short",
    "int",
    "long",
    "float",
    "double",
    "byteArray",
    "string",
    "list",
    "compound",
    "intArray",
    "longArray",
  ];

  function convertCompoundRecord(record) {
    var out = {};
    for (var key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      out[key] = convertTagged(record[key]);
    }
    return out;
  }

  function convertListValue(listJson) {
    var elemType = listJson.type;
    var typeName = TYPE_NAMES[elemType] || String(elemType);
    var items = (listJson.items || []).map(function (item) {
      if (elemType === 10) {
        return { type: "compound", value: convertCompoundRecord(item) };
      }
      if (elemType === 9) {
        return { type: "list", value: convertListValue(item) };
      }
      return { type: typeName, value: item };
    });
    return { type: typeName, value: items };
  }

  function convertTagged(tagged) {
    if (!tagged || typeof tagged !== "object" || !("type" in tagged)) {
      return tagged;
    }
    var typeName = TYPE_NAMES[tagged.type] || String(tagged.type);
    if (tagged.type === 10) {
      return { type: "compound", value: convertCompoundRecord(tagged.value) };
    }
    if (tagged.type === 9) {
      return { type: "list", value: convertListValue(tagged.value) };
    }
    return { type: typeName, value: tagged.value };
  }

  function readNbt(array, options) {
    if (!window.deepslate || !window.deepslate.NbtFile) {
      throw new Error("deepslate.NbtFile is not available");
    }
    var file = window.deepslate.NbtFile.read(array, options);
    var result = {
      name: file.name,
      value: convertCompoundRecord(file.root.toJson()),
    };
    if (file.compression && file.compression !== "none") {
      result.compression = file.compression;
    }
    if (file.littleEndian) {
      result.littleEndian = true;
    }
    if (file.bedrockHeader != null) {
      result.bedrockHeader = file.bedrockHeader;
    }
    return result;
  }

  if (window.deepslate && typeof window.deepslate.readNbt !== "function") {
    window.deepslate.readNbt = readNbt;
  }
})();
