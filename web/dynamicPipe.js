import { app } from "../../scripts/app.js";


const PACK = "ToDynamicPipe";
const UNPACK = "FromDynamicPipe";
const PIPE_TYPE = "DYNAMIC_PIPE";
const SCHEMA_WIDGET = "_schema";
const CONFIGURING = Symbol("dynamicPipeConfiguring");


function isNode(node, type) {
  return node?.comfyClass === type || node?.type === type;
}


function graphFor(node) {
  return node?.graph || app.graph;
}


function rootGraphFor(graph) {
  return graph?.rootGraph || graph;
}


function isActiveNode(node) {
  const activeRoot = app.rootGraph || rootGraphFor(app.graph);
  return !activeRoot || rootGraphFor(graphFor(node)) === activeRoot;
}


function linkFor(graph, linkId) {
  return graph?.getLink?.(linkId) || graph?.links?.[linkId];
}


function nodesFor(graph) {
  return graph?._nodes || graph?.nodes || [];
}


function graphsFor(rootGraph) {
  const graphs = [rootGraph];
  if (rootGraph?.subgraphs?.values) {
    graphs.push(...rootGraph.subgraphs.values());
  }
  return graphs;
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


function isPlaceholderInput(input) {
  return /^\*(?:_\d+)?$/.test(String(input?.label || "*"));
}


function isPackValueInput(input) {
  return /^value_\d+$/.test(String(input?.name || ""));
}


function isConfiguredInput(input) {
  return input?.dynamicPipeConfigured === true && !isPlaceholderInput(input);
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
  const key = nextInputKey(node);
  const input = node.addInput(key, "*");
  input.label = "*";
  input.dynamicPipeConfigured = false;
}


function ensureEmptyInput(node, connectedInput = null) {
  const reusableInput = (node.inputs || []).find(
    (input) =>
      isPackValueInput(input) &&
      input !== connectedInput &&
      !isConfiguredInput(input) &&
      input.link == null,
  );
  if (reusableInput) {
    return;
  }
  addEmptyInput(node);
}


function pruneEmptyInputs(node) {
  const emptyInputs = (node.inputs || []).filter(
    (input) =>
      isPackValueInput(input) && !isConfiguredInput(input) && input.link == null,
  );
  const inputsToRemove = new Set(emptyInputs.slice(1));
  for (let index = node.inputs.length - 1; index >= 0; index--) {
    if (inputsToRemove.has(node.inputs[index])) {
      node.removeInput(index);
    }
  }
}


function uniqueLabel(node, desired, currentInput) {
  const base = String(desired || "value").trim() || "value";
  const used = new Set(
    (node.inputs || [])
      .filter(
        (input) =>
          isPackValueInput(input) && input !== currentInput && isConfiguredInput(input),
      )
      .map((input) => String(input.label || input.name).toLocaleLowerCase()),
  );

  let label = base;
  let suffix = 2;
  while (used.has(label.toLocaleLowerCase())) {
    label = `${base}_${suffix++}`;
  }
  return label;
}


function sourceDetails(node, linkInfo) {
  const graph = graphFor(node);
  const origin = graph?.getNodeById(linkInfo?.origin_id);
  const output =
    origin?.outputs?.[linkInfo?.origin_slot] ||
    origin?.slots?.[linkInfo?.origin_slot] ||
    origin?.allSlots?.[linkInfo?.origin_slot] ||
    graph?.inputNode?.slots?.[linkInfo?.origin_slot];
  if (!output) {
    return null;
  }

  const name =
    output.displayName ||
    output.label ||
    output.localized_name ||
    output.name ||
    output.type ||
    "value";
  return { name: String(name), type: String(linkInfo?.type || output.type || "*") };
}


function readPackSchema(node) {
  return (node.inputs || [])
    .filter((input) => isPackValueInput(input) && isConfiguredInput(input))
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


function updateLinkType(node, output, type) {
  const graph = graphFor(node);
  for (const linkId of output.links || []) {
    const link = linkFor(graph, linkId);
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


function applySchemaToUnpack(node, schema, preserveLinks = false) {
  if (preserveLinks && schema.length < (node.outputs?.length || 0)) {
    return;
  }

  for (let index = 0; index < schema.length; index++) {
    const field = schema[index];
    let output = node.outputs?.[index];
    if (!output) {
      output = node.addOutput(field.name, field.type);
    } else {
      const changed = output.name !== field.name || String(output.type) !== field.type;
      if (!preserveLinks && changed && output.links?.length) {
        node.disconnectOutput(index);
      }
      output.name = field.name;
      output.label = field.name;
      output.type = field.type;
    }
    output.dynamicPipeKey = field.key;
    updateLinkType(node, output, field.type);
  }

  while (!preserveLinks && (node.outputs?.length || 0) > schema.length) {
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
    const graph = graphFor(current);
    const link = linkFor(graph, input.link);
    const origin = graph?.getNodeById(link?.origin_id);
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


function syncUnpack(node, preserveLinks = false) {
  const pack = upstreamPack(node);
  if (pack) {
    applySchemaToUnpack(node, readPackSchema(pack), preserveLinks);
  }
}


function notifyConnectedUnpacks(pack, preserveLinks = false) {
  for (const node of nodesFor(graphFor(pack))) {
    if (isNode(node, UNPACK) && upstreamPack(node) === pack) {
      applySchemaToUnpack(node, readPackSchema(pack), preserveLinks);
    }
  }
}


function updatePack(node, preserveUnpackLinks = false) {
  ensureEmptyInput(node);
  const schema = readPackSchema(node);
  setSchemaWidget(node, schema);
  resizeNode(node);
  notifyConnectedUnpacks(node, preserveUnpackLinks);
}


function configurePackInput(node, slotIndex, connected, linkInfo) {
  const input = node.inputs?.[slotIndex];
  if (!input) {
    return;
  }
  if (!isPackValueInput(input)) {
    return;
  }

  if (connected) {
    ensureEmptyInput(node, input);
    const graphLink = linkFor(graphFor(node), input.link);
    const liveLink = graphLink || linkInfo;
    const source = sourceDetails(node, liveLink);
    if (!source) {
      updatePack(node, true);
      return;
    }
    input.label = uniqueLabel(node, source.name, input);
    input.type = source.type;
    input.dynamicPipeType = source.type;
    input.dynamicPipeConfigured = true;
  } else {
    input.label = "*";
    input.type = "*";
    input.dynamicPipeConfigured = false;
    pruneEmptyInputs(node);
  }
  updatePack(node, connected);
}


function setupNode(node) {
  hideSchemaWidget(node);
  if (isNode(node, PACK)) {
    const savedFields = new Map(parseWidgetSchema(node).map((field) => [field.key, field]));
    for (const input of node.inputs || []) {
      if (!isPackValueInput(input)) {
        continue;
      }
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
    for (const input of node.inputs || []) {
      if (!isPackValueInput(input) || input.link == null) {
        continue;
      }
      const link = linkFor(graphFor(node), input.link);
      const source = sourceDetails(node, link);
      if (!source) {
        continue;
      }
      input.label = uniqueLabel(node, source.name, input);
      input.type = source.type;
      input.dynamicPipeType = source.type;
      input.dynamicPipeConfigured = true;
    }
    updatePack(node, true);
  } else if (isNode(node, UNPACK)) {
    applySchemaToUnpack(node, parseWidgetSchema(node), true);
    syncUnpack(node, true);
  }
}


app.registerExtension({
  name: "DynamicPipe.slots",

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== PACK && nodeData.name !== UNPACK) {
      return;
    }

    const configure = nodeType.prototype.configure;
    nodeType.prototype.configure = function () {
      this[CONFIGURING] = true;
      let configured = false;
      try {
        const result = configure.apply(this, arguments);
        configured = true;
        return result;
      } finally {
        this[CONFIGURING] = false;
        if (configured) {
          setTimeout(() => {
            if (this.graph) {
              setupNode(this);
            }
          }, 0);
        }
      }
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, slotIndex, connected, linkInfo) {
      const result = onConnectionsChange?.apply(this, arguments);
      if (
        type !== LiteGraph.INPUT ||
        app.configuringGraph ||
        this[CONFIGURING] ||
        (!connected && !isActiveNode(this))
      ) {
        return result;
      }

      if (nodeData.name === PACK) {
        setTimeout(() => configurePackInput(this, slotIndex, connected, linkInfo), 0);
      } else if (connected && slotIndex === 0) {
        setTimeout(() => syncUnpack(this, true), 0);
      }
      return result;
    };

    if (nodeData.name === PACK) {
      const onConnectInput = nodeType.prototype.onConnectInput;
      nodeType.prototype.onConnectInput = function (slotIndex) {
        const result = onConnectInput?.apply(this, arguments);
        if (result !== false && !app.configuringGraph && !this[CONFIGURING]) {
          requestAnimationFrame(() => {
            const input = this.inputs?.[slotIndex];
            if (input?.link != null) {
              configurePackInput(this, slotIndex, true, linkFor(graphFor(this), input.link));
            }
          });
        }
        return result;
      };
    }
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
    const rootGraph = app.rootGraph || rootGraphFor(app.graph);
    for (const graph of graphsFor(rootGraph)) {
      for (const node of nodesFor(graph)) {
        if (isNode(node, PACK) || isNode(node, UNPACK)) {
          setupNode(node);
        }
      }
    }
  },
});
