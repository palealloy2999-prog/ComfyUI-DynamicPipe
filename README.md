# ComfyUI Dynamic Pipe

[日本語版 README](./README.ja.md)

A pair of ComfyUI custom nodes that packs any number of values of any type into a single dynamic pipe and unpacks them elsewhere in the workflow.

<img width="1324" height="645" alt="image" src="https://github.com/user-attachments/assets/0a07fa5e-98ab-460a-a17f-9345277a432c" />

## Nodes

- `to Dynamic Pipe`: Packs IMAGE, MODEL, LATENT, STRING, and other values into one output.
- `from Dynamic Pipe`: Creates outputs with the same names, types, and order as the inputs on `to Dynamic Pipe`.

## Usage

1. Add `to Dynamic Pipe` and `from Dynamic Pipe` from the `utils/pipe` category.
2. Connect a value to the `*` input on `to Dynamic Pipe`. A new empty `*` input is added automatically after each connection.
3. Connect the `dynamic_pipe` pins on the two nodes.
4. Use the named outputs created automatically on `from Dynamic Pipe`.

Each input adopts the name of its connected upstream output. Duplicate names receive a numeric suffix such as `_2` or `_3`.

Disconnecting `dynamic_pipe` from `from Dynamic Pipe` preserves its last output layout and downstream connections. When it is connected to a different `to Dynamic Pipe`, downstream links are removed only from outputs whose name or type changed, preventing values from being routed incorrectly.

## Installation

```shell
cd ComfyUI/custom_nodes
git clone https://github.com/palealloy2999-prog/ComfyUI-DynamicPipe.git
```

Restart ComfyUI and reload the browser. No additional dependencies are required.
