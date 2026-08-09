import { app } from "../../scripts/app.js";


const PACK = "ToDynamicPipe";
const UNPACK = "FromDynamicPipe";
const PIPE_TYPE = "DYNAMIC_PIPE";
const SCHEMA_WIDGET = "_schema";


function isNode(node, type) {
  return node?.comfyClass === type || node?.type === type;
}


function schemaWidget(node) {
  return node.widgets?.find((widget) => widget.name === SCHEMA_WIDGET);
}


function hideSchemaWidget(node) {
  const widget = schemaWidget(node);
  if (!widget || widget.dynamicPipeHidden) {
    return;
  }

  widget.dynamicPipeHidden = true;
  widget.hidden = true;
  widget.computeSize = () => [0, -4];
}


function isConfiguredInput(input) {
  return input?.dynamicPipeConfigured === true || input?.label !== "*";
}


function nextInputKey(node) {
  let highest = 0;
  for (const input of node.inputs || []) {
    const match = /^value_(\d+)$/.exec(input.name);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `value_${highest + 1}`;
}


function addEmptyInput(node) {
  const input = node.addInput(nextInputKey(node), "*");
  input.label = "*";
  input.dynamicPipeConfigured = false;
}


function ensureEmptyInput(node) {
  for (let index = (node.inputs?.length || 0) - 1; index >= 0; index--) {
    const input = node.inputs[index];
    if (!isConfiguredInput(input) && input.link == null) {
      node.removeInput(index);
    }
  }
  addEmptyInput(node);
}


function uniqueLabel(node, desired, currentInput) {
  const base = String(desired || "value").trim() || "value";
  const used = new Set(
    (node.inputs || [])
      .filter((input) => input !== currentInput && isConfiguredInput(input))
      .map((input) => String(input.label || input.name).toLocaleLowerCase()),
  );

  let label = base;
  let suffix = 2;
  while (used.has(label.toLocaleLowerCase())) {
    label = `${base}_${suffix++}`;
  }
  return label;
}


function sourceDetails(linkInfo) {
  const origin = app.graph?.getNodeById(linkInfo?.origin_id);
  const output = origin?.outputs?.[linkInfo?.origin_slot];
  if (!output) {
    return { name: "value", type: String(linkInfo?.type || "*") };
  }

  const name = output.label || output.name || output.type || "value";
  return { name: String(name), type: String(linkInfo?.type || output.type || "*") };
}


function readPackSchema(node) {
  return (node.inputs || [])
    .filter(isConfiguredInput)
    .map((input) => ({
      key: input.name,
      name: String(input.label || input.name),
      type: String(input.dynamicPipeType || input.type || "*"),
    }));
}


function setSchemaWidget(node, schema) {
  const widget = schemaWidget(node);
  if (widget) {
    widget.value = JSON.stringify(schema);
  }
}


function parseWidgetSchema(node) {
  try {
    const schema = JSON.parse(schemaWidget(node)?.value || "[]");
    return Array.isArray(schema) ? schema : [];
  } catch {
    return [];
  }
}


function updateLinkType(output, type) {
  for (const linkId of output.links || []) {
    const link = app.graph?.links?.[linkId];
    if (!link) {
      continue;
    }
    link.type = type;
    link.color = LGraphCanvas.link_type_colors[type];
  }
}


function resizeNode(node) {
  const computed = node.computeSize();
  node.setSize([Math.max(node.size[0], computed[0]), computed[1]]);
  node.setDirtyCanvas(true, true);
}


function applySchemaToUnpack(node, schema) {
  for (let index = 0; index < schema.length; index++) {
    const field = schema[index];
    let output = node.outputs?.[index];
    if (!output) {
      output = node.addOutput(field.name, field.type);
    } else {
      const changed = output.name !== field.name || String(output.type) !== field.type;
      if (changed && output.links?.length) {
        node.disconnectOutput(index);
      }
      output.name = field.name;
      output.label = field.name;
      output.type = field.type;
    }
    output.dynamicPipeKey = field.key;
    updateLinkType(output, field.type);
  }

  while ((node.outputs?.length || 0) > schema.length) {
    const index = node.outputs.length - 1;
    if (node.outputs[index].links?.length) {
      node.disconnectOutput(index);
    }
    node.removeOutput(index);
  }

  setSchemaWidget(node, schema);
  resizeNode(node);
}


function upstreamPack(node) {
  const visited = new Set();
  let current = node;
  let input = current.inputs?.find((slot) => slot.name === "dynamic_pipe") || current.inputs?.[0];

  while (input?.link != null) {
    const link = app.graph?.links?.[input.link];
    const origin = app.graph?.getNodeById(link?.origin_id);
    if (!origin || visited.has(origin.id)) {
      return null;
    }
    if (isNode(origin, PACK)) {
      return origin;
    }

    visited.add(origin.id);
    const pipeInputs = (origin.inputs || []).filter(
      (slot) => slot.link != null && String(slot.type) === PIPE_TYPE,
    );
    if (pipeInputs.length !== 1) {
      return null;
    }
    current = origin;
    input = pipeInputs[0];
  }
  return null;
}


function syncUnpack(node) {
  const pack = upstreamPack(node);
  if (pack) {
    applySchemaToUnpack(node, readPackSchema(pack));
  }
}


function notifyConnectedUnpacks(pack) {
  for (const node of app.graph?._nodes || []) {
    if (isNode(node, UNPACK) && upstreamPack(node) === pack) {
      applySchemaToUnpack(node, readPackSchema(pack));
    }
  }
}


function updatePack(node) {
  ensureEmptyInput(node);
  setSchemaWidget(node, readPackSchema(node));
  resizeNode(node);
  notifyConnectedUnpacks(node);
}


function configurePackInput(node, slotIndex, connected, linkInfo) {
  const input = node.inputs?.[slotIndex];
  if (!input) {
    return;
  }

  if (connected) {
    const source = sourceDetails(linkInfo);
    input.label = uniqueLabel(node, source.name, input);
    input.type = source.type;
    input.dynamicPipeType = source.type;
    input.dynamicPipeConfigured = true;
  } else if (isConfiguredInput(input)) {
    input.type = "*";
  }
  updatePack(node);
}


function setupNode(node) {
  hideSchemaWidget(node);
  if (isNode(node, PACK)) {
    const savedFields = new Map(parseWidgetSchema(node).map((field) => [field.key, field]));
    for (const input of node.inputs || []) {
      const field = savedFields.get(input.name);
      if (field) {
        input.label = field.name;
        input.dynamicPipeType = field.type;
        input.dynamicPipeConfigured = true;
      } else if (input.link != null) {
        input.label = input.label || input.name;
        input.dynamicPipeType = input.type;
        input.dynamicPipeConfigured = true;
      } else {
        input.label = "*";
        input.dynamicPipeConfigured = false;
      }
    }
    updatePack(node);
  } else if (isNode(node, UNPACK)) {
    applySchemaToUnpack(node, parseWidgetSchema(node));
    syncUnpack(node);
  }
}


app.registerExtension({
  name: "DynamicPipe.slots",

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== PACK && nodeData.name !== UNPACK) {
      return;
    }

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, slotIndex, connected, linkInfo) {
      const result = onConnectionsChange?.apply(this, arguments);
      if (type !== LiteGraph.INPUT) {
        return result;
      }

      if (nodeData.name === PACK) {
        setTimeout(() => configurePackInput(this, slotIndex, connected, linkInfo), 0);
      } else if (connected && slotIndex === 0) {
        setTimeout(() => syncUnpack(this), 0);
      }
      return result;
    };
  },

  nodeCreated(node) {
    if (isNode(node, PACK) || isNode(node, UNPACK)) {
      setupNode(node);
    }
  },

  loadedGraphNode(node) {
    if (isNode(node, PACK) || isNode(node, UNPACK)) {
      setTimeout(() => setupNode(node), 0);
    }
  },

  afterConfigureGraph() {
    for (const node of app.graph?._nodes || []) {
      if (isNode(node, PACK) || isNode(node, UNPACK)) {
        setupNode(node);
      }
    }
  },
});
