import { app } from "../../scripts/app.js";


const PACK = "ToDynamicPipe";
const UNPACK = "FromDynamicPipe";
const PIPE_TYPE = "DYNAMIC_PIPE";
const SCHEMA_WIDGET = "_schema";
const CONFIGURING = Symbol("dynamicPipeConfiguring");
const VIRTUAL_WATCHERS = Symbol("dynamicPipeVirtualWatchers");
const VIRTUAL_RENAME_WRAPPED = Symbol("dynamicPipeVirtualRenameWrapped");
const WATCHED_VIRTUALS = Symbol("dynamicPipeWatchedVirtuals");
const SCHEMA_SERIALIZER = Symbol("dynamicPipeSchemaSerializer");
const BOUNDARY_CONNECTION_WRAPPED = Symbol("dynamicPipeBoundaryConnectionWrapped");
const PACK_PRESENTATION_SIGNATURE = Symbol("dynamicPipePackPresentationSignature");
const PACK_PRESENTATION_PENDING = Symbol("dynamicPipePackPresentationPending");
const INSTANCE_STATE_VERSION = 1;
const WORKFLOW_BINDINGS = new WeakMap();


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
  if (!widget) {
    return;
  }

  if (!widget.dynamicPipeHidden) {
    widget.dynamicPipeHidden = true;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
  }

  const inputIndex = node.inputs?.findIndex((input) => input.name === SCHEMA_WIDGET) ?? -1;
  if (inputIndex !== -1) {
    node.removeInput(inputIndex);
    node._setConcreteSlots?.();
  }
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
  if (!origin && linkInfo?.origin_id != null) {
    return null;
  }
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
  return { name: String(name), type: String(output.type || linkInfo?.type || "*") };
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


function normalizeSchema(schema) {
  if (!Array.isArray(schema)) {
    return [];
  }
  return schema
    .filter((field) => field && field.key != null)
    .map((field) => ({
      key: String(field.key),
      name: String(field.name || field.key),
      type: String(field.type || "*"),
    }));
}


function instanceState(rootGraph, create = true) {
  if (!rootGraph) {
    return null;
  }
  const extra = rootGraph.extra || (create ? (rootGraph.extra = {}) : null);
  if (!extra) {
    return null;
  }
  let state = extra.dynamicPipe;
  if (!state || state.version !== INSTANCE_STATE_VERSION || !state.schemas) {
    if (!create) {
      return null;
    }
    state = { version: INSTANCE_STATE_VERSION, schemas: {} };
    extra.dynamicPipe = state;
  }
  return state;
}


function cachedSchema(rootGraph, executionId) {
  const value = instanceState(rootGraph, false)?.schemas?.[String(executionId)];
  return normalizeSchema(value);
}


function cacheSchema(rootGraph, executionId, schema) {
  if (executionId == null) {
    return;
  }
  instanceState(rootGraph).schemas[String(executionId)] = normalizeSchema(schema);
}


function executionNode(value) {
  return value?.node || value;
}


function executionIdFor(path, node) {
  return [...path, node.id].join(":");
}


function outputDetails(output, fallbackType = "*") {
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
  return { name: String(name), type: String(output.type || fallbackType || "*") };
}


function uniqueSchemaName(fields, desired) {
  const base = String(desired || "value").trim() || "value";
  const used = new Set(fields.map((field) => field.name.toLocaleLowerCase()));
  let name = base;
  let suffix = 2;
  while (used.has(name.toLocaleLowerCase())) {
    name = `${base}_${suffix++}`;
  }
  return name;
}


function resolvedSourceDetails(resolved) {
  const source = executionNode(resolved?.node);
  const slot = resolved?.origin_slot;
  const output =
    source?.outputs?.[slot] || source?.slots?.[slot] || source?.allSlots?.[slot];
  return outputDetails(output, resolved?.type);
}


function subgraphInputDetails(graph, slot, parentInput = null) {
  const boundarySlot =
    graph?.inputs?.[slot] ||
    graph?.inputNode?.slots?.[slot];
  if (!boundarySlot && !parentInput) {
    return null;
  }
  return {
    name: String(
      boundarySlot?.displayName ||
      boundarySlot?.label ||
      boundarySlot?.localized_name ||
      boundarySlot?.name ||
      parentInput?.label ||
      parentInput?.name ||
      "value",
    ),
    type: String(boundarySlot?.type || parentInput?.type || "*"),
  };
}


function dtoInstancePath(executableNode) {
  if (Array.isArray(executableNode?.subgraphNodePath)) {
    return [...executableNode.subgraphNodePath];
  }
  return [];
}


function parentInstance(rootGraph, path) {
  if (!path?.length) {
    return null;
  }
  const parentPath = path.slice(0, -1);
  const graph = graphAtPath(rootGraph, parentPath);
  const node = graph?.getNodeById?.(path[path.length - 1]);
  return node ? { graph, node, path: parentPath } : null;
}


function resolvePhysicalOutput(rootGraph, graph, node, slot, path, visited) {
  if (!node) {
    return null;
  }
  const visitKey = `${path.join(":")}|${node.id}|${slot}`;
  if (visited.has(visitKey)) {
    return null;
  }
  visited.add(visitKey);

  if (node.mode === 2) {
    return null;
  }
  if (node.mode === 4) {
    const input = node.inputs?.[slot]?.link != null
      ? node.inputs[slot]
      : node.inputs?.find((candidate) => candidate.link != null);
    return input
      ? resolvePhysicalLink(rootGraph, graph, linkFor(graph, input.link), path, visited)
      : null;
  }

  if (node.isSubgraphNode?.() || node.subgraph) {
    const source = enterSubgraphOutput(node, slot);
    return source
      ? resolvePhysicalOutput(
          rootGraph,
          node.subgraph,
          source.node,
          source.slot,
          [...path, node.id],
          visited,
        )
      : null;
  }

  if (node.isVirtualNode) {
    const source = virtualOutputSource(node, slot);
    return source
      ? resolvePhysicalOutput(rootGraph, graphFor(source.node), source.node, source.slot, path, visited)
      : null;
  }

  const output =
    node.outputs?.[slot] || node.slots?.[slot] || node.allSlots?.[slot];
  return outputDetails(output);
}


function resolvePhysicalLink(rootGraph, graph, link, path, visited = new Set()) {
  if (!link) {
    return null;
  }
  const isInputBoundary = Boolean(
    link.originIsIoNode ||
    link.origin_id === -10 ||
    link.origin_id === graph?.inputNode?.id
  );
  if (isInputBoundary) {
    const parent = parentInstance(rootGraph, path);
    const parentInput = parent?.node?.inputs?.[link.origin_slot];
    const boundary = subgraphInputDetails(graph, link.origin_slot, parentInput);
    const outerLink = linkFor(parent?.graph, parentInput?.link);
    const outerDetails = parent
      ? resolvePhysicalLink(rootGraph, parent.graph, outerLink, parent.path, visited)
      : null;
    return {
      // The subgraph input owns the semantic field name. The physical source
      // may expose a generic name such as CONDITIONING, which must not replace
      // user-defined boundary names such as positive and negative.
      name: String(boundary?.name || outerDetails?.name || "value"),
      // A disconnected parent still has a stable subgraph slot contract.
      type: String(
        outerDetails?.type && outerDetails.type !== "*"
          ? outerDetails.type
          : boundary?.type && boundary.type !== "*"
            ? boundary.type
            : parentInput?.type || "*",
      ),
    };
  }

  const origin = graph?.getNodeById?.(link.origin_id);
  return resolvePhysicalOutput(
    rootGraph,
    graph,
    origin,
    link.origin_slot,
    path,
    visited,
  );
}


function derivePackSchemaFromContext(rootGraph, node, path) {
  const executionId = executionIdFor(path, node);
  const fallback = new Map([
    ...parseWidgetSchema(node),
    ...cachedSchema(rootGraph, executionId),
  ].map((field) => [String(field.key), field]));
  const schema = [];
  let complete = true;

  for (const input of node.inputs || []) {
    if (!isPackValueInput(input) || input.link == null) {
      continue;
    }
    const details = resolvePhysicalLink(
      rootGraph,
      graphFor(node),
      linkFor(graphFor(node), input.link),
      path,
    );
    const previous = fallback.get(String(input.name));
    const field = details
      ? {
          name: details.name || previous?.name,
          type: details.type && details.type !== "*"
            ? details.type
            : previous?.type || "*",
        }
      : previous;
    if (!details) {
      complete = false;
    }
    if (!field) {
      continue;
    }
    schema.push({
      key: String(input.name),
      name: uniqueSchemaName(schema, field.name),
      type: String(field.type || "*"),
    });
  }
  return { schema: normalizeSchema(schema), complete };
}


function derivePackSchema(executableNode) {
  const node = executionNode(executableNode);
  const root = rootGraphFor(graphFor(node));
  const executionId = String(executableNode?.id ?? node?.id ?? "");
  const fallback = new Map([
    ...parseWidgetSchema(node),
    ...cachedSchema(root, executionId),
  ].map((field) => [String(field.key), field]));
  const schema = [];
  let complete = true;

  for (let index = 0; index < (node?.inputs?.length || 0); index++) {
    const input = node.inputs[index];
    if (!isPackValueInput(input)) {
      continue;
    }
    const connected = input.link != null || executableNode?.inputs?.[index]?.linkId != null;
    if (!connected) {
      continue;
    }

    const inputLink = linkFor(graphFor(node), input.link);
    const boundary = isSubgraphInputLink(node, input)
      ? subgraphInputDetails(graphFor(node), inputLink?.origin_slot)
      : null;
    let details = null;
    try {
      // Dynamic Pack inputs accept every type. Passing an explicit wildcard is
      // essential here: the slot can have an instance-specific display type,
      // which must not constrain DTO traversal through bypass nodes.
      details = resolvedSourceDetails(
        executableNode?.resolveInput?.(index, new Set(), "*"),
      );
    } catch {
      // A temporarily incomplete subgraph can fail resolution while it is edited.
    }
    const previous = fallback.get(String(input.name));
    if (details && boundary) {
      details = {
        name: boundary.name,
        type: details.type && details.type !== "*" ? details.type : boundary.type,
      };
    }
    if (!details) {
      complete = false;
      details =
        (boundary?.type !== "*" ? boundary : null) ||
        previous ||
        boundary ||
        (isConfiguredInput(input) ? {
          name: input.label || input.name,
          type: input.dynamicPipeType || input.type || "*",
        } : null);
    }
    if (!details) {
      continue;
    }
    schema.push({
      key: String(input.name),
      name: uniqueSchemaName(schema, details.name),
      type: String(details.type || "*"),
    });
  }
  return { schema: normalizeSchema(schema), complete };
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


function isDynamicPipeOutput(outputType, output) {
  return String(output?.type ?? outputType) === PIPE_TYPE;
}


function rejectInvalidUnpackInput(node) {
  const input = node.inputs?.[0];
  const graph = graphFor(node);
  const link = linkFor(graph, input?.link);
  const origin = graph?.getNodeById(link?.origin_id);
  const output = origin?.outputs?.[link?.origin_slot];
  if (input?.link != null && !isDynamicPipeOutput(link?.type, output)) {
    node.disconnectInput(0);
  }
}


function resizeNode(node) {
  const computed = node.computeSize();
  node.setSize([Math.max(node.size[0], computed[0]), computed[1]]);
  node.setDirtyCanvas(true, true);
}


function applySchemaToUnpack(node, schema, preserveLinks = false) {
  schema = normalizeSchema(schema);
  if (preserveLinks && schema.length < (node.outputs?.length || 0)) {
    return;
  }

  const oldSchema = normalizeSchema(parseWidgetSchema(node));
  for (let index = 0; index < (node.outputs?.length || 0); index++) {
    const output = node.outputs[index];
    output.dynamicPipeKey ||= oldSchema[index]?.key;
  }

  const existing = new Map(
    (node.outputs || [])
      .filter((output) => output.dynamicPipeKey != null)
      .map((output) => [String(output.dynamicPipeKey), output]),
  );
  const desired = [];
  for (const field of schema) {
    let output = existing.get(field.key);
    if (!output) {
      output = node.addOutput(field.name, field.type);
    } else if (!preserveLinks && String(output.type) !== field.type && output.links?.length) {
      node.disconnectOutput(node.outputs.indexOf(output));
    }
    output.name = field.name;
    output.label = field.name;
    output.type = field.type;
    output.dynamicPipeKey = field.key;
    desired.push(output);
  }

  if (!preserveLinks) {
    const desiredSet = new Set(desired);
    for (let index = (node.outputs?.length || 0) - 1; index >= 0; index--) {
      if (desiredSet.has(node.outputs[index])) {
        continue;
      }
      if (node.outputs[index].links?.length) {
        node.disconnectOutput(index);
      }
      node.removeOutput(index);
    }
  }

  if (!preserveLinks || desired.length === (node.outputs?.length || 0)) {
    node.outputs = desired;
    const graph = graphFor(node);
    for (let index = 0; index < desired.length; index++) {
      for (const linkId of desired[index].links || []) {
        const link = linkFor(graph, linkId);
        if (link) {
          link.origin_slot = index;
        }
      }
    }
  }
  for (const field of schema) {
    const output = desired.find((candidate) => candidate.dynamicPipeKey === field.key);
    updateLinkType(node, output, field.type);
  }

  setSchemaWidget(node, schema);
  node._setConcreteSlots?.();
  resizeNode(node);
}


function clearVirtualWatches(node) {
  for (const virtualNode of node[WATCHED_VIRTUALS] || []) {
    virtualNode[VIRTUAL_WATCHERS]?.delete(node);
  }
  node[WATCHED_VIRTUALS]?.clear();
}


function watchVirtualNode(node, virtualNode) {
  const watched = node[WATCHED_VIRTUALS] ||= new Set();
  if (watched.has(virtualNode)) {
    return;
  }

  watched.add(virtualNode);
  const watchers = virtualNode[VIRTUAL_WATCHERS] ||= new Set();
  watchers.add(node);

  if (virtualNode[VIRTUAL_RENAME_WRAPPED] || typeof virtualNode.onRename !== "function") {
    return;
  }

  const onRename = virtualNode.onRename;
  virtualNode.onRename = function () {
    const result = onRename.apply(this, arguments);
    setTimeout(() => {
      for (const unpack of [...(this[VIRTUAL_WATCHERS] || [])]) {
        if (unpack.graph) {
          syncUnpack(unpack);
        } else {
          this[VIRTUAL_WATCHERS].delete(unpack);
        }
      }
    }, 0);
    return result;
  };
  virtualNode[VIRTUAL_RENAME_WRAPPED] = true;
}


function virtualOutputSource(node, slot) {
  const graph = graphFor(node);
  try {
    const inputLink = node.getInputLink?.(slot);
    const link = typeof inputLink === "object" ? inputLink : linkFor(graph, inputLink);
    const origin = graph?.getNodeById(link?.origin_id);
    if (origin) {
      return { node: origin, slot: link.origin_slot };
    }
  } catch {
    // An unconfigured third-party virtual node may reject source resolution.
  }

  try {
    const source = node.resolveVirtualOutput?.(slot);
    if (source?.node) {
      return { node: source.node, slot: source.slot };
    }
  } catch {
    return null;
  }
  return null;
}


function upstreamPackExecutable(executableNode) {
  const visited = new Set();
  let current = executableNode;
  while (current) {
    const node = executionNode(current);
    if (isNode(node, PACK)) {
      return current;
    }
    const inputIndex = (node.inputs || []).findIndex(
      (input) => input.name === "dynamic_pipe" || String(input.type) === PIPE_TYPE,
    );
    if (inputIndex < 0) {
      return null;
    }
    let resolved;
    try {
      resolved = current.resolveInput?.(inputIndex);
    } catch {
      return null;
    }
    current = resolved?.node;
    const executionId = String(current?.id ?? "");
    if (!current || visited.has(executionId)) {
      return null;
    }
    visited.add(executionId);
  }
  return null;
}


function schemaForExecutableUnpack(executableNode) {
  const pack = upstreamPackExecutable(executableNode);
  return pack ? derivePackSchema(pack).schema : [];
}


function installSchemaSerializer(node) {
  const widget = schemaWidget(node);
  if (!widget || widget[SCHEMA_SERIALIZER]) {
    return;
  }
  const previous = widget.serializeValue;
  widget.serializeValue = function (executableNode, widgetIndex) {
    try {
      if (executableNode?.id != null && executableNode?.resolveInput) {
        if (isNode(node, PACK)) {
          return JSON.stringify(derivePackSchema(executableNode).schema);
        }
        const pack = upstreamPackExecutable(executableNode);
        if (pack) {
          return JSON.stringify(derivePackSchema(pack).schema);
        }
      }
    } catch (error) {
      console.warn("DynamicPipe: failed to resolve instance schema", error);
    }
    return previous
      ? previous.call(this, executableNode, widgetIndex)
      : this.value;
  };
  widget[SCHEMA_SERIALIZER] = true;
}


function enterSubgraphOutput(subgraphNode, slot) {
  try {
    const resolved = subgraphNode.resolveSubgraphOutputLink?.(slot);
    if (resolved?.outputNode && resolved?.link) {
      return {
        node: resolved.outputNode,
        slot: resolved.link.origin_slot,
      };
    }
  } catch {
    // The output can be transiently incomplete while editing the subgraph.
  }
  return null;
}


function upstreamPackContext(node, initialPath = []) {
  clearVirtualWatches(node);
  const visited = new Set();
  let current = node;
  let path = [...initialPath];
  let input = current.inputs?.find((slot) => slot.name === "dynamic_pipe") || current.inputs?.[0];

  while (input?.link != null) {
    const graph = graphFor(current);
    const link = linkFor(graph, input.link);
    let origin = graph?.getNodeById(link?.origin_id);
    let originSlot = link?.origin_slot;
    if (!origin) {
      return null;
    }

    while (origin) {
      const visitKey = `${path.join(":")}|${origin.id}|${originSlot}`;
      if (visited.has(visitKey)) {
        return null;
      }
      visited.add(visitKey);

      if (isNode(origin, PACK)) {
        return {
          node: origin,
          executionId: executionIdFor(path, origin),
          path,
        };
      }

      if (origin.isSubgraphNode?.() || origin.subgraph) {
        const source = enterSubgraphOutput(origin, originSlot);
        if (!source) {
          return null;
        }
        path = [...path, origin.id];
        origin = source.node;
        originSlot = source.slot;
        continue;
      }

      if (origin.isVirtualNode) {
        watchVirtualNode(node, origin);
        const source = virtualOutputSource(origin, originSlot);
        if (source) {
          origin = source.node;
          originSlot = source.slot;
          continue;
        }
      }

      const pipeInputs = (origin.inputs || []).filter(
        (slot) => slot.link != null && String(slot.type) === PIPE_TYPE,
      );
      if (pipeInputs.length !== 1) {
        return null;
      }
      current = origin;
      input = pipeInputs[0];
      break;
    }
  }
  return null;
}


function upstreamPack(node) {
  return upstreamPackContext(node)?.node || null;
}


function executionDtos(rootGraph) {
  const result = new Map();
  for (const node of nodesFor(rootGraph)) {
    if (!(node.isSubgraphNode?.() || node.subgraph) || !node.getInnerNodes) {
      continue;
    }
    try {
      for (const dto of node.getInnerNodes(result) || []) {
        result.set(String(dto.id), dto);
      }
    } catch (error) {
      console.warn("DynamicPipe: failed to enumerate subgraph instances", error);
    }
  }
  return result;
}


function graphAtPath(rootGraph, path) {
  let graph = rootGraph;
  for (const id of path || []) {
    const node = graph?.getNodeById?.(id);
    if (!(node?.isSubgraphNode?.() || node?.subgraph)) {
      return null;
    }
    graph = node.subgraph;
  }
  return graph;
}


function pathsForGraph(rootGraph, targetGraph) {
  const paths = [];
  function visit(graph, path, ancestors) {
    if (graph === targetGraph) {
      paths.push(path);
    }
    if (ancestors.has(graph)) {
      return;
    }
    const nextAncestors = new Set(ancestors).add(graph);
    for (const node of nodesFor(graph)) {
      if (node.isSubgraphNode?.() || node.subgraph) {
        visit(node.subgraph, [...path, node.id], nextAncestors);
      }
    }
  }
  visit(rootGraph, [], new Set());
  return paths;
}


function presentationPath(rootGraph, graph, binding) {
  if (graph === rootGraph) {
    return [];
  }
  if (binding?.activePath && graphAtPath(rootGraph, binding.activePath) === graph) {
    return binding.activePath;
  }
  const paths = pathsForGraph(rootGraph, graph);
  return paths.length === 1 ? paths[0] : null;
}


function isSubgraphInputLink(node, input) {
  const graph = graphFor(node);
  const link = linkFor(graph, input?.link);
  if (!link) {
    return false;
  }
  return Boolean(
    link.originIsIoNode ||
    link.origin_id === -10 ||
    link.origin_id === graph?.inputNode?.id ||
    graph?.getNodeById?.(link.origin_id) === graph?.inputNode
  );
}


function updateInputPresentation(node, input, type, boundaryInput) {
  const color = LGraphCanvas.link_type_colors[type] || LiteGraph.LINK_COLOR;
  input.color_on = color;
  input.color_off = color;
  const link = linkFor(graphFor(node), input?.link);
  if (link) {
    if (!boundaryInput) {
      link.type = type;
    }
    link.color = color;
  }
}


function applySchemaToPackPresentation(node, schema) {
  const fields = new Map(normalizeSchema(schema).map((field) => [field.key, field]));
  for (const input of node.inputs || []) {
    if (!isPackValueInput(input) || input.link == null) {
      continue;
    }
    const field = fields.get(String(input.name));
    if (!field) {
      continue;
    }
    const boundaryInput = isSubgraphInputLink(node, input);
    input.label = field.name;
    // A subgraph input belongs to the shared definition. Keep its physical
    // contract wildcard so each instance can resolve a different source type.
    input.type = boundaryInput ? "*" : field.type;
    input.dynamicPipeType = field.type;
    input.dynamicPipeConfigured = true;
    updateInputPresentation(node, input, field.type, boundaryInput);
  }
  ensureEmptyInput(node);
  resizeNode(node);
}


function refreshVisiblePack(node) {
  if (app.configuringGraph || graphFor(node) !== app.canvas?.graph) {
    return;
  }
  const root = rootGraphFor(graphFor(node));
  const binding = WORKFLOW_BINDINGS.get(root);
  const path = presentationPath(root, graphFor(node), binding);
  if (!path) {
    return;
  }
  const derived = derivePackSchemaFromContext(root, node, path);
  if (!derived.complete) {
    return;
  }
  const executionId = executionIdFor(path, node);
  const signature = `${executionId}|${JSON.stringify(derived.schema)}`;
  if (node[PACK_PRESENTATION_SIGNATURE] === signature || node[PACK_PRESENTATION_PENDING]) {
    return;
  }
  node[PACK_PRESENTATION_PENDING] = true;
  setTimeout(() => {
    node[PACK_PRESENTATION_PENDING] = false;
    if (!node.graph) {
      return;
    }
    cacheSchema(root, executionId, derived.schema);
    applySchemaToPackPresentation(node, derived.schema);
    node[PACK_PRESENTATION_SIGNATURE] = signature;

    for (const candidate of nodesFor(graphFor(node))) {
      if (!isNode(candidate, UNPACK)) {
        continue;
      }
      const context = upstreamPackContext(candidate, path);
      if (context?.node === node) {
        applySchemaToUnpack(candidate, derived.schema);
      }
    }
  }, 0);
}


function watchBoundaryNode(node) {
  if (node?.[BOUNDARY_CONNECTION_WRAPPED]) {
    return;
  }
  const onConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const result = onConnectionsChange?.apply(this, arguments);
    scheduleReconcile(rootGraphFor(graphFor(this)), "active");
    return result;
  };
  node[BOUNDARY_CONNECTION_WRAPPED] = true;
}


function schemaForPackContext(rootGraph, context) {
  const cached = cachedSchema(rootGraph, context?.executionId);
  return cached.length ? cached : readPackSchema(context?.node);
}


function attachGraphEvents(rootGraph, binding) {
  for (const graph of graphsFor(rootGraph)) {
    if (!graph || binding.observedGraphs.has(graph)) {
      continue;
    }
    binding.observedGraphs.add(graph);
    if (graph.events?.addEventListener) {
      for (const eventName of [
        "subgraph-created",
        "input-added",
        "removing-input",
        "renaming-input",
        "output-added",
        "removing-output",
        "renaming-output",
      ]) {
        graph.events.addEventListener(
          eventName,
          () => scheduleReconcile(rootGraph, "active"),
          { signal: binding.controller.signal },
        );
      }
    }

    const previousOnTrigger = graph.onTrigger;
    const onTrigger = function (event) {
      const result = previousOnTrigger?.apply(this, arguments);
      if (event?.type === "node:slot-links:changed") {
        scheduleReconcile(rootGraph, "active");
      }
      return result;
    };
    graph.onTrigger = onTrigger;
    binding.cleanups.push(() => {
      if (graph.onTrigger === onTrigger) {
        graph.onTrigger = previousOnTrigger;
      }
    });
  }
}


function reconcileWorkflow(rootGraph, mode = "passive") {
  if (!rootGraph) {
    return;
  }
  const binding = WORKFLOW_BINDINGS.get(rootGraph);
  attachGraphEvents(rootGraph, binding || {
    observedGraphs: new Set(),
    controller: new AbortController(),
    cleanups: [],
  });
  const preserveLinks = mode !== "active";
  const dtos = executionDtos(rootGraph);
  const dtoIdsByNode = new Map();

  for (const graph of graphsFor(rootGraph)) {
    for (const node of nodesFor(graph)) {
      if (node.isSubgraphNode?.() || node.subgraph) {
        watchBoundaryNode(node);
      }
    }
  }

  for (const dto of dtos.values()) {
    const node = executionNode(dto);
    if (!node) {
      continue;
    }
    installSchemaSerializer(node);
    const ids = dtoIdsByNode.get(node) || [];
    ids.push(String(dto.id));
    dtoIdsByNode.set(node, ids);
    if (isNode(node, PACK)) {
      const contextual = derivePackSchemaFromContext(
        rootGraph,
        node,
        dtoInstancePath(dto),
      );
      const derived = contextual.complete ? contextual : derivePackSchema(dto);
      if (derived.complete) {
        cacheSchema(rootGraph, dto.id, derived.schema);
      }
    }
  }

  for (const node of nodesFor(rootGraph)) {
    if (isNode(node, PACK)) {
      installSchemaSerializer(node);
      cacheSchema(rootGraph, node.id, readPackSchema(node));
    }
  }

  const presentations = [];
  for (const [node, ids] of dtoIdsByNode) {
    const path = presentationPath(rootGraph, graphFor(node), binding);
    const preferredId = path ? executionIdFor(path, node) : null;
    const chosenId = preferredId && ids.includes(preferredId)
      ? preferredId
      : ids.length === 1 ? ids[0] : null;
    if (!chosenId) {
      continue;
    }
    const dto = dtos.get(chosenId);
    presentations.push({ node, dto, path: path || dtoInstancePath(dto), chosenId });
  }

  // Resolve and cache every visible Pack first so a connected Unpack can use
  // the same instance schema during this reconciliation pass.
  for (const presentation of presentations) {
    const { node, dto, path, chosenId } = presentation;
    if (!isNode(node, PACK)) {
      continue;
    }
    const contextual = derivePackSchemaFromContext(rootGraph, node, path);
    const derived = contextual.complete ? contextual : derivePackSchema(dto);
    if (derived.complete) {
      cacheSchema(rootGraph, chosenId, derived.schema);
    }
    if (derived.schema.length) {
      applySchemaToPackPresentation(node, derived.schema);
      node[PACK_PRESENTATION_SIGNATURE] =
        `${chosenId}|${JSON.stringify(derived.schema)}`;
    }
  }

  for (const presentation of presentations) {
    const { node, dto, path } = presentation;
    if (!isNode(node, UNPACK)) {
      continue;
    }
    const context = upstreamPackContext(node, path);
    const contextualSchema = context
      ? schemaForPackContext(rootGraph, context)
      : [];
    const schema = contextualSchema.length
      ? contextualSchema
      : schemaForExecutableUnpack(dto);
    if (schema.length) {
      applySchemaToUnpack(node, schema, preserveLinks);
    }
  }

  for (const node of nodesFor(rootGraph)) {
    if (!isNode(node, UNPACK)) {
      continue;
    }
    installSchemaSerializer(node);
    const context = upstreamPackContext(node, []);
    if (context) {
      applySchemaToUnpack(node, schemaForPackContext(rootGraph, context), preserveLinks);
    }
  }
}


function scheduleReconcile(rootGraph, mode = "active") {
  if (!rootGraph) {
    return;
  }
  let binding = WORKFLOW_BINDINGS.get(rootGraph);
  if (!binding) {
    bindWorkflow(rootGraph);
    binding = WORKFLOW_BINDINGS.get(rootGraph);
  }
  binding.mode = binding.mode === "active" || mode === "active" ? "active" : "passive";
  if (binding.timer != null) {
    return;
  }
  binding.timer = setTimeout(() => {
    binding.timer = null;
    const nextMode = binding.mode;
    binding.mode = "passive";
    reconcileWorkflow(rootGraph, nextMode);
  }, 0);
}


function bindWorkflow(rootGraph) {
  if (!rootGraph) {
    return;
  }
  const previous = WORKFLOW_BINDINGS.get(rootGraph);
  previous?.controller.abort();
  for (const cleanup of previous?.cleanups || []) {
    cleanup();
  }
  if (previous?.timer != null) {
    clearTimeout(previous.timer);
  }
  const binding = {
    controller: new AbortController(),
    cleanups: [],
    observedGraphs: new Set(),
    activePath: previous?.activePath || [],
    timer: null,
    mode: "passive",
  };
  WORKFLOW_BINDINGS.set(rootGraph, binding);
  attachGraphEvents(rootGraph, binding);

  const canvas = app.canvas?.canvas;
  if (canvas?.addEventListener) {
    canvas.addEventListener("subgraph-opening", (event) => {
      const fromNode = event.detail?.fromNode;
      const closingGraph = event.detail?.closingGraph;
      if (!fromNode) {
        return;
      }
      const base = presentationPath(rootGraph, closingGraph, binding);
      if (base) {
        binding.activePath = [...base, fromNode.id];
        scheduleReconcile(rootGraph, "active");
      }
    }, { signal: binding.controller.signal });
    canvas.addEventListener("subgraph-opened", () => {
      const currentGraph = app.canvas?.graph || app.graph;
      if (currentGraph === rootGraph) {
        binding.activePath = [];
      } else if (graphAtPath(rootGraph, binding.activePath) !== currentGraph) {
        const candidates = pathsForGraph(rootGraph, currentGraph);
        if (candidates.length === 1) {
          binding.activePath = candidates[0];
        }
      }
      scheduleReconcile(rootGraph, "passive");
    }, { signal: binding.controller.signal });
  }
}


function syncUnpack(node, preserveLinks = false) {
  const root = rootGraphFor(graphFor(node));
  const binding = WORKFLOW_BINDINGS.get(root);
  const path = presentationPath(root, graphFor(node), binding);
  const context = path ? upstreamPackContext(node, path) : upstreamPackContext(node);
  if (context) {
    applySchemaToUnpack(node, schemaForPackContext(root, context), preserveLinks);
  }
  scheduleReconcile(root, preserveLinks ? "passive" : "active");
}


function notifyConnectedUnpacks(pack, preserveLinks = false) {
  scheduleReconcile(
    rootGraphFor(graphFor(pack)),
    preserveLinks ? "passive" : "active",
  );
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
    delete input.color_on;
    delete input.color_off;
    input.label = uniqueLabel(node, source.name, input);
    input.type = source.type;
    input.dynamicPipeType = source.type;
    input.dynamicPipeConfigured = true;
  } else {
    input.label = "*";
    input.type = "*";
    delete input.color_on;
    delete input.color_off;
    input.dynamicPipeConfigured = false;
    pruneEmptyInputs(node);
  }
  updatePack(node, connected);
}


function setupNode(node) {
  hideSchemaWidget(node);
  installSchemaSerializer(node);
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
          hideSchemaWidget(this);
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
      } else if (slotIndex === 0) {
        if (connected) {
          setTimeout(() => {
            rejectInvalidUnpackInput(this);
            if (this.inputs?.[0]?.link != null) {
              syncUnpack(this);
            }
          }, 0);
        } else {
          clearVirtualWatches(this);
        }
      }
      return result;
    };

    if (nodeData.name === UNPACK) {
      const onRemoved = nodeType.prototype.onRemoved;
      nodeType.prototype.onRemoved = function () {
        clearVirtualWatches(this);
        return onRemoved?.apply(this, arguments);
      };

      const onConnectInput = nodeType.prototype.onConnectInput;
      nodeType.prototype.onConnectInput = function (slotIndex, outputType, output) {
        const result = onConnectInput?.apply(this, arguments);
        if (result === false) {
          return false;
        }
        return slotIndex !== 0 || isDynamicPipeOutput(outputType, output);
      };
    }

    if (nodeData.name === PACK) {
      const onDrawForeground = nodeType.prototype.onDrawForeground;
      nodeType.prototype.onDrawForeground = function () {
        const result = onDrawForeground?.apply(this, arguments);
        refreshVisiblePack(this);
        return result;
      };

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
    bindWorkflow(rootGraph);
    for (const graph of graphsFor(rootGraph)) {
      for (const node of nodesFor(graph)) {
        if (isNode(node, PACK) || isNode(node, UNPACK)) {
          setupNode(node);
        }
      }
    }
    scheduleReconcile(rootGraph, "passive");
  },
});
