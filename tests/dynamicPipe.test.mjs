import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

let source = fs.readFileSync(new URL("../web/dynamicPipe.js", import.meta.url), "utf8");
source = source.replace(/^import[^\n]+\n/, "");
source += `
globalThis.dynamicPipeTestApi = {
  applySchemaToPackPresentation,
  applySchemaToUnpack,
  cacheSchema,
  cachedSchema,
  derivePackSchema,
  derivePackSchemaFromContext,
  installSchemaSerializer,
  reconcileWorkflow,
  refreshVisiblePack,
  upstreamPackContext,
};`;

const app = {
  graph: null,
  rootGraph: null,
  registerExtension(extension) {
    this.extension = extension;
  },
};
const context = vm.createContext({
  AbortController,
  app,
  clearTimeout,
  console,
  LGraphCanvas: {
    link_type_colors: {
      IMAGE: "green",
      LATENT: "purple",
      MODEL: "lavender",
      CLIP: "yellow",
      VAE: "red",
    },
  },
  LiteGraph: { INPUT: 1 },
  requestAnimationFrame(callback) { callback(); },
  setTimeout,
});
vm.runInContext(source, context, { filename: "dynamicPipe.js" });
const api = context.dynamicPipeTestApi;

function graph(nodes = [], links = {}) {
  const value = {
    _nodes: nodes,
    links,
    getLink(id) { return this.links[id]; },
    getNodeById(id) { return this._nodes.find((node) => node.id === id); },
  };
  for (const node of nodes) node.graph = value;
  return value;
}

function schemaWidget(value = "[]") {
  return { name: "_schema", value };
}

function packNode(id = 10) {
  return {
    id,
    comfyClass: "ToDynamicPipe",
    inputs: [{ name: "value_1", label: "*", type: "*", link: 1 }],
    widgets: [schemaWidget()],
  };
}

function sourceDto(type, name) {
  return { node: { outputs: [{ type, name }] } };
}

function unpackNode(id, link) {
  return {
    id,
    comfyClass: "FromDynamicPipe",
    inputs: [{ name: "dynamic_pipe", type: "DYNAMIC_PIPE", link }],
    outputs: [],
    widgets: [schemaWidget()],
    size: [100, 40],
    computeSize() { return [100, 40 + this.outputs.length * 20]; },
    setSize(size) { this.size = size; },
    setDirtyCanvas() {},
    addOutput(name, type) {
      const output = { name, type, links: [] };
      this.outputs.push(output);
      return output;
    },
    disconnectOutput(index) { this.outputs[index].links = null; },
    removeOutput(index) { this.outputs.splice(index, 1); },
  };
}

{
  const sources = [
    { id: 1, outputs: [{ name: "MODEL", type: "MODEL" }] },
    { id: 2, outputs: [{ name: "CLIP", type: "CLIP" }] },
    { id: 3, outputs: [{ name: "VAE", type: "VAE" }] },
  ];
  const pack = {
    id: 10,
    comfyClass: "ToDynamicPipe",
    inputs: [
      { name: "value_1", label: "*", type: "*", link: 101 },
      { name: "value_2", label: "*", type: "*", link: 102 },
      { name: "value_3", label: "*", type: "*", link: 103 },
      { name: "value_4", label: "*", type: "*", link: null },
    ],
    widgets: [schemaWidget()],
    size: [100, 60],
    computeSize() { return [100, 100]; },
    setSize(size) { this.size = size; },
    setDirtyCanvas() {},
    outputs: [{ name: "dynamic_pipe", type: "DYNAMIC_PIPE", links: [104] }],
  };
  const unpack = unpackNode(11, 104);
  const inner = graph([pack, unpack], {
    101: { origin_id: -10, origin_slot: 0, originIsIoNode: true, type: "*" },
    102: { origin_id: -10, origin_slot: 1, originIsIoNode: true, type: "*" },
    103: { origin_id: -10, origin_slot: 2, originIsIoNode: true, type: "*" },
    104: { origin_id: 10, origin_slot: 0, target_id: 11, target_slot: 0, type: "DYNAMIC_PIPE" },
  });
  inner.inputNode = {
    id: -10,
    slots: [
      { name: "model", type: "MODEL" },
      { name: "clip", type: "CLIP" },
      { name: "vae", type: "VAE" },
    ],
  };
  const instance = {
    id: 20,
    subgraph: inner,
    inputs: [
      { name: "model", link: 201 },
      { name: "clip", link: 202 },
      { name: "vae", link: 203 },
    ],
    isSubgraphNode() { return true; },
    getInnerNodes(map) {
      const packDto = {
        id: "20:10",
        node: pack,
        subgraphNodePath: [20],
        inputs: pack.inputs.map((input) => ({ linkId: input.link })),
        resolveInput() { return undefined; },
      };
      const unpackDto = {
        id: "20:11",
        node: unpack,
        subgraphNodePath: [20],
        inputs: [{ linkId: 104 }],
        resolveInput() { return { node: packDto, origin_slot: 0 }; },
      };
      map.set(packDto.id, packDto);
      map.set(unpackDto.id, unpackDto);
      return [packDto, unpackDto];
    },
  };
  const root = graph([...sources, instance], {
    201: { origin_id: 1, origin_slot: 0, type: "MODEL" },
    202: { origin_id: 2, origin_slot: 0, type: "CLIP" },
    203: { origin_id: 3, origin_slot: 0, type: "VAE" },
  });
  root.rootGraph = root;
  root.subgraphs = new Map([["shared", inner]]);
  inner.rootGraph = root;

  const derived = api.derivePackSchemaFromContext(root, pack, [20]);
  assert.equal(derived.complete, true);
  assert.deepEqual(JSON.parse(JSON.stringify(derived.schema)), [
    { key: "value_1", name: "model", type: "MODEL" },
    { key: "value_2", name: "clip", type: "CLIP" },
    { key: "value_3", name: "vae", type: "VAE" },
  ]);
  api.applySchemaToPackPresentation(pack, derived.schema);
  assert.deepEqual(
    pack.inputs.slice(0, 3).map((input) => [input.label, input.type, input.color_on]),
    [["model", "*", "lavender"], ["clip", "*", "yellow"], ["vae", "*", "red"]],
  );

  api.reconcileWorkflow(root, "active");
  assert.deepEqual(
    JSON.parse(JSON.stringify(unpack.outputs.map((output) => [output.name, output.type]))),
    [["model", "MODEL"], ["clip", "CLIP"], ["vae", "VAE"]],
  );

  sources[0].outputs[0] = { name: "LATENT", type: "LATENT" };
  app.canvas = { graph: inner };
  api.refreshVisiblePack(pack);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    [pack.inputs[0].label, pack.inputs[0].type, pack.inputs[0].color_on],
    ["model", "*", "purple"],
  );
  assert.deepEqual(
    [unpack.outputs[0].name, unpack.outputs[0].type],
    ["model", "LATENT"],
  );

  // Disconnecting the parent input keeps the subgraph slot's name and type.
  instance.inputs[1].link = null;
  const disconnected = api.derivePackSchemaFromContext(root, pack, [20]);
  assert.equal(disconnected.complete, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(disconnected.schema[1])),
    { key: "value_2", name: "clip", type: "CLIP" },
  );
  inner.inputNode.slots[1].type = "*";
  const wildcardBoundary = api.derivePackSchemaFromContext(root, pack, [20]);
  assert.equal(wildcardBoundary.schema[1].type, "CLIP");
}

{
  const pack = {
    id: 10,
    comfyClass: "ToDynamicPipe",
    inputs: [
      { name: "value_1", label: "*", type: "*", link: 1 },
      { name: "value_2", label: "*", type: "*", link: null },
    ],
    size: [100, 40],
    computeSize() { return [100, 60]; },
    setSize(size) { this.size = size; },
    setDirtyCanvas() {},
  };
  const owner = graph([pack], {
    1: { origin_id: -10, originIsIoNode: true, type: "*", color: null },
  });
  owner.inputNode = { id: -10 };
  api.applySchemaToPackPresentation(pack, [
    { key: "value_1", name: "image", type: "IMAGE" },
  ]);
  assert.equal(pack.inputs[0].label, "image");
  assert.equal(pack.inputs[0].type, "*");
  assert.equal(pack.inputs[0].color_on, "green");
  assert.equal(owner.links[1].type, "*");
  assert.equal(owner.links[1].color, "green");
}

{
  const root = graph();
  root.rootGraph = root;
  const pack = packNode();
  // Reproduce a previously persisted/display-mutated concrete slot type. DTO
  // traversal must still request wildcard because this is a Dynamic Pack input.
  pack.inputs[0].type = "CONDITIONING";
  const subgraph = graph([pack]);
  subgraph.rootGraph = root;
  let resolvedAsType;
  const imageDto = {
    id: "20:10",
    node: pack,
    inputs: [{ linkId: "20:1" }],
    resolveInput(index, visited, type) {
      resolvedAsType = type;
      return type === "*"
        ? { node: sourceDto("IMAGE", "image"), origin_slot: 0 }
        : undefined;
    },
  };
  const latentDto = {
    ...imageDto,
    id: "21:10",
    resolveInput() { return { node: sourceDto("LATENT", "latent"), origin_slot: 0 }; },
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(api.derivePackSchema(imageDto).schema)),
    [{ key: "value_1", name: "image", type: "IMAGE" }],
  );
  assert.equal(resolvedAsType, "*");
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.derivePackSchema(latentDto).schema)),
    [{ key: "value_1", name: "latent", type: "LATENT" }],
  );

  api.cacheSchema(root, imageDto.id, api.derivePackSchema(imageDto).schema);
  api.cacheSchema(root, latentDto.id, api.derivePackSchema(latentDto).schema);
  assert.equal(api.cachedSchema(root, "20:10")[0].type, "IMAGE");
  assert.equal(api.cachedSchema(root, "21:10")[0].type, "LATENT");

  api.installSchemaSerializer(pack);
  assert.equal(JSON.parse(pack.widgets[0].serializeValue(imageDto))[0].type, "IMAGE");
  assert.equal(JSON.parse(pack.widgets[0].serializeValue(latentDto))[0].type, "LATENT");

  const unpack = {
    id: 30,
    comfyClass: "FromDynamicPipe",
    inputs: [{ name: "dynamic_pipe", type: "DYNAMIC_PIPE", link: 2 }],
    widgets: [schemaWidget()],
  };
  api.installSchemaSerializer(unpack);
  const unpackDto = {
    id: "30",
    node: unpack,
    resolveInput() { return { node: imageDto, origin_slot: 0 }; },
  };
  assert.equal(JSON.parse(unpack.widgets[0].serializeValue(unpackDto))[0].type, "IMAGE");
}

{
  const sharedPack = packNode(10);
  sharedPack.size = [100, 40];
  sharedPack.computeSize = () => [100, 60];
  sharedPack.setSize = () => {};
  sharedPack.setDirtyCanvas = () => {};
  sharedPack.addInput = function (name, type) {
    const input = { name, type, link: null };
    this.inputs.push(input);
    return input;
  };
  const sharedGraph = graph([sharedPack]);
  const root = graph();
  root.rootGraph = root;
  sharedGraph.rootGraph = root;

  const imageDto = {
    id: "20:10",
    node: sharedPack,
    inputs: [{ linkId: "20:1" }],
    resolveInput() { return { node: sourceDto("IMAGE", "image"), origin_slot: 0 }; },
  };
  const latentDto = {
    ...imageDto,
    id: "21:10",
    resolveInput() { return { node: sourceDto("LATENT", "latent"), origin_slot: 0 }; },
  };
  function instance(id, dto) {
    return {
      id,
      subgraph: sharedGraph,
      isSubgraphNode() { return true; },
      getInnerNodes(map) { map.set(dto.id, dto); return [dto]; },
      resolveSubgraphOutputLink() {
        return { outputNode: sharedPack, link: { origin_slot: 0 } };
      },
    };
  }
  const imageInstance = instance(20, imageDto);
  const latentInstance = instance(21, latentDto);
  const imageUnpack = unpackNode(30, 30);
  const latentUnpack = unpackNode(31, 31);
  root._nodes.push(imageInstance, latentInstance, imageUnpack, latentUnpack);
  for (const node of root._nodes) node.graph = root;
  root.links = {
    30: { origin_id: 20, origin_slot: 0, type: "DYNAMIC_PIPE" },
    31: { origin_id: 21, origin_slot: 0, type: "DYNAMIC_PIPE" },
  };

  api.reconcileWorkflow(root, "active");
  assert.equal(imageUnpack.outputs[0].type, "IMAGE");
  assert.equal(latentUnpack.outputs[0].type, "LATENT");
  assert.equal(root.extra.dynamicPipe.schemas["20:10"][0].type, "IMAGE");
  assert.equal(root.extra.dynamicPipe.schemas["21:10"][0].type, "LATENT");
}

{
  const positiveSource = { id: 41, outputs: [{ name: "CONDITIONING", type: "CONDITIONING" }] };
  const negativeSource = { id: 42, outputs: [{ name: "CONDITIONING", type: "CONDITIONING" }] };
  const pack = packNode(43);
  pack.inputs = [
    { name: "value_1", label: "*", type: "*", link: 301 },
    { name: "value_2", label: "*", type: "*", link: 302 },
  ];
  const inner = graph([pack], {
    301: { origin_id: -10, origin_slot: 0, originIsIoNode: true, type: "*" },
    302: { origin_id: -10, origin_slot: 1, originIsIoNode: true, type: "*" },
  });
  inner.inputNode = {
    id: -10,
    slots: [
      { name: "positive", type: "CONDITIONING" },
      { name: "negative", type: "CONDITIONING" },
    ],
  };
  const instance = {
    id: 44,
    subgraph: inner,
    inputs: [{ link: 401 }, { link: 402 }],
    isSubgraphNode() { return true; },
  };
  const root = graph([positiveSource, negativeSource, instance], {
    401: { origin_id: 41, origin_slot: 0, type: "CONDITIONING" },
    402: { origin_id: 42, origin_slot: 0, type: "CONDITIONING" },
  });
  root.rootGraph = root;
  inner.rootGraph = root;

  const schema = api.derivePackSchemaFromContext(root, pack, [44]).schema;
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), [
    { key: "value_1", name: "positive", type: "CONDITIONING" },
    { key: "value_2", name: "negative", type: "CONDITIONING" },
  ]);

  const dto = {
    id: "44:43",
    node: pack,
    subgraphNodePath: [44],
    inputs: [{ linkId: 301 }, { linkId: 302 }],
    resolveInput(index, visited, type) {
      assert.equal(type, "*");
      return {
        node: sourceDto("CONDITIONING", "CONDITIONING"),
        origin_slot: 0,
      };
    },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(api.derivePackSchema(dto).schema)), [
    { key: "value_1", name: "positive", type: "CONDITIONING" },
    { key: "value_2", name: "negative", type: "CONDITIONING" },
  ]);
}

{
  const innerPack = packNode();
  const subgraphNode = {
    id: 20,
    subgraph: {},
    isSubgraphNode() { return true; },
    resolveSubgraphOutputLink() {
      return { outputNode: innerPack, link: { origin_slot: 0 } };
    },
  };
  const unpack = {
    id: 30,
    comfyClass: "FromDynamicPipe",
    inputs: [{ name: "dynamic_pipe", type: "DYNAMIC_PIPE", link: 5 }],
  };
  const root = graph([subgraphNode, unpack], {
    5: { origin_id: 20, origin_slot: 0, type: "DYNAMIC_PIPE" },
  });
  root.rootGraph = root;
  innerPack.graph = subgraphNode.subgraph;
  subgraphNode.subgraph.rootGraph = root;
  assert.equal(api.upstreamPackContext(unpack).executionId, "20:10");
}

{
  const links = {
    11: { origin_slot: 0, type: "IMAGE" },
    12: { origin_slot: 1, type: "LATENT" },
  };
  const node = {
    id: 40,
    comfyClass: "FromDynamicPipe",
    size: [100, 80],
    outputs: [
      { name: "old image", type: "IMAGE", links: [11], dynamicPipeKey: "value_1" },
      { name: "latent", type: "LATENT", links: [12], dynamicPipeKey: "value_2" },
    ],
    widgets: [schemaWidget(JSON.stringify([
      { key: "value_1", name: "old image", type: "IMAGE" },
      { key: "value_2", name: "latent", type: "LATENT" },
    ]))],
    computeSize() { return [100, 80]; },
    setSize() {},
    setDirtyCanvas() {},
    addOutput(name, type) {
      const output = { name, type, links: [] };
      this.outputs.push(output);
      return output;
    },
    disconnectOutput(index) { this.outputs[index].links = null; },
    removeOutput(index) { this.outputs.splice(index, 1); },
  };
  graph([node], links);

  api.applySchemaToUnpack(node, [
    { key: "value_2", name: "latent renamed", type: "LATENT" },
    { key: "value_1", name: "image renamed", type: "IMAGE" },
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(node.outputs.map((output) => output.dynamicPipeKey))),
    ["value_2", "value_1"],
  );
  assert.equal(node.outputs[0].links[0], 12);
  assert.equal(node.outputs[1].links[0], 11);
  assert.equal(links[12].origin_slot, 0);
  assert.equal(links[11].origin_slot, 1);

  api.applySchemaToUnpack(node, [
    { key: "value_2", name: "latent renamed", type: "IMAGE" },
    { key: "value_1", name: "image renamed", type: "IMAGE" },
  ]);
  assert.equal(node.outputs[0].links, null);
  assert.deepEqual(JSON.parse(JSON.stringify(node.outputs[1].links)), [11]);
}

console.log("dynamicPipe focused tests passed");
