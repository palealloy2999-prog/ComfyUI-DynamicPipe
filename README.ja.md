# ComfyUI Dynamic Pipe

[English README](./README.md)

任意の型・任意の本数の値を1本のpipeにまとめ、別のノードで展開するComfyUIカスタムノードです。

<img width="1324" height="645" alt="image" src="https://github.com/user-attachments/assets/0a07fa5e-98ab-460a-a17f-9345277a432c" />

## ノード

- `to Dynamic Pipe`: IMAGE、MODEL、LATENT、STRINGなどをまとめて出力します。
- `from Dynamic Pipe`: `to Dynamic Pipe`の入力と同じ名前・型・順番の出力を表示します。

## 使い方

1. `utils/pipe`から`to Dynamic Pipe`と`from Dynamic Pipe`を追加します。
2. `to Dynamic Pipe`の`*`ピンへ値を接続します。接続するたびに新しい`*`ピンが追加されます。
3. 両ノードの`dynamic_pipe`ピンを接続します。
4. `from Dynamic Pipe`に自動表示された名前付き出力を利用します。

`to Dynamic Pipe`の入力名には接続元の出力名が使われます。同名の場合は`_2`、`_3`のように連番が付きます。

`dynamic_pipe`を`from Dynamic Pipe`から外しても最後の出力構成は残るため、後続ノードへの配線は維持されます。別の`to Dynamic Pipe`へつなぎ替えて名前または型が変わった出力については、誤接続を防ぐため後続の配線が解除されます。

## インストール

```shell
cd ComfyUI/custom_nodes
git clone https://github.com/palealloy2999-prog/ComfyUI-DynamicPipe.git
```

ComfyUIを再起動し、ブラウザを再読み込みしてください。追加依存関係はありません。
