# DynamicPipe サブグラフ対応 実装指示書

## 目的

DynamicPipe がサブグラフ境界を越える構成で、次の動作を満たすこと。

1. `to Dynamic Pipe` がサブグラフ内、`from Dynamic Pipe` が外側にある場合、外側の `from` が正しいフィールドを展開する。
2. サブグラフ外の値をサブグラフ内の `to` が受け取る場合、実際の接続元に基づく名前・型・ピン色を表示する。
3. 同じサブグラフ定義を複数配置し、それぞれ異なる型を入力しても、各インスタンスの Queue 用 schema が混ざらない。
4. 接続、切断、差し替え、保存・再読込、サブグラフの開閉後も schema と出力を同期する。
5. 既存のノードID、入力キー、出力順、`widgets_values` の位置、旧ワークフローを維持する。

対象として確認した環境は ComfyUI `0.41.0`、frontend `1.45.21`。実装時には対象環境の API を再確認すること。

## 現在の問題

### サブグラフ出力を内側へ辿れない

現在の `upstreamPack()` は、外側の `from` からサブグラフノードへ到達しても、`resolveSubgraphOutputLink()` を使って内部出力へ進まない。

`SubgraphNode.getInputLink()` が返す `20:10` のような階層付き実行IDを、外側グラフの `getNodeById()` に渡しているため、内部の `to` を取得できない。サブグラフに `DYNAMIC_PIPE` 入力が1本ある場合は、その入力元を誤って上流の `to` と判定することもある。

### サブグラフ入力を外側へ辿れない

サブグラフ内の `to` に接続されたリンクの起点は、サブグラフ入力境界 `origin_id === -10` になる。現在の `sourceDetails()` は境界スロットまでは参照するが、そのインスタンスの外側リンクまでは解決しない。

また、型の決定が `linkInfo.type || output.type || "*"` になっている。境界内リンクの `type` が `"*"` の場合、外部の物理接続元が `IMAGE` や `LATENT` でも `"*"` が優先される。

### schema がサブグラフ定義で共有される

サブグラフ内のノードオブジェクトと `_schema` widget は定義に属する。同じ定義を複数の `SubgraphNode` から使うと、現在の `_schema` は全インスタンスで1つしかない。

例:

```text
Subgraph instance 20: IMAGE  -> inner to node 10
Subgraph instance 21: LATENT -> inner to node 10
```

内部ノードは共通でも、実行IDは `20:10` と `21:10` になる。schema の正本を内部ノードの widget だけに置くと、最後に同期したインスタンスの型が他方へ漏れる。

### 変更通知が同じグラフ内だけに限定される

`notifyConnectedUnpacks()` は `nodesFor(graphFor(pack))` のみを走査する。そのため、境界の反対側にある `from` は更新されない。サブグラフノード側の外部入力だけを差し替えた場合も、内部 `to` の `onConnectionsChange` は発火しない。

## 守るべき契約

- Python の公開ノードID `ToDynamicPipe` / `FromDynamicPipe` を変更しない。
- `value_N` をフィールドの永続キーとして維持する。表示名や配列位置を識別子にしない。
- schema のフィールド形式 `{key, name, type}` を維持する。
- `_schema` widget の位置を変えず、widget を増減しない。
- `DYNAMIC_PIPE` の Python 値形式を維持する。
- 保存済み schema は、ライブ接続が一時的に解決できない場合の復元用として残す。
- passive な読込・タブ切替・サブグラフ開閉では、解決失敗だけを理由にピンや downstream link を削除しない。
- Queue 用 schema は実行インスタンス単位で決定し、表示中インスタンスの状態に依存させない。

## 設計方針

schema を次の3層に分ける。

1. **実行時 schema**
   Queue に送る正本。完全な実行IDごとに導出する。
2. **インスタンス schema cache**
   UI復元と接続変更通知に使う永続キャッシュ。ワークフロー単位で実行IDをキーに保存する。
3. **ノード widget の `_schema`**
   旧ワークフロー互換と、インスタンスを特定できない場合のフォールバック。共有サブグラフでは実行時の正本にしない。

## インスタンス schema の保存形式

ルートグラフの `extra` に名前空間付きで保存する。

```json
{
  "extra": {
    "dynamicPipe": {
      "version": 1,
      "schemas": {
        "20:10": [
          {"key": "value_1", "name": "image", "type": "IMAGE"}
        ],
        "21:10": [
          {"key": "value_1", "name": "latent", "type": "LATENT"}
        ]
      }
    }
  }
}
```

- キーは `to Dynamic Pipe` の完全な実行IDとする。
- ルートの `to` は通常のローカルID文字列、サブグラフ内は `親インスタンスID:内部ID`、ネスト時は `親:子:内部ID` とする。
- 同じサブグラフ定義でも、`20:10` と `21:10` は別エントリになる。
- schema 配列の順序は内部 `to` の `value_N` 入力順に固定する。
- `name` と `type` はインスタンスごとに異なってよいが、`key` は内部ノードの入力名と一致させる。
- 時刻などの非決定的な値を保存しない。
- 解決途中の `value` や境界由来の `*` を新しい正規 schema として保存しない。最終的な物理出力が本当に ANY 型の場合だけ `*` を許容する。

ルート `extra` を使う理由は、ネストされた `SubgraphNode` 自体も上位の共有定義に含まれるためである。ネストした `SubgraphNode.properties` に保存しても、異なるルートインスタンス間で再び共有される。完全な実行IDをルートに保存すれば、すべての階層を区別できる。

## Queue 用 schema の生成

frontend `1.45.21` の `graphToPrompt()` は、widget の `serializeValue(executableNode, widgetIndex)` に `ExecutableNodeDTO` を渡す。この経路を利用し、`graphToPrompt` 自体は置換しない。

### `to Dynamic Pipe`

`_schema` widget に、1回だけインスタンス対応の `serializeValue` を設定する。

```js
schemaWidget.serializeValue = (executableNode) => {
  const result = derivePackSchemaForExecution(executableNode, "queue");
  return JSON.stringify(result.schema);
};
```

`derivePackSchemaForExecution()` は次の処理を行う。

1. `executableNode.id` を完全な Pack 実行IDとして取得する。
2. Pack の `value_N` 入力をノード上の順序で走査する。
3. 各入力について `ExecutableNodeDTO.resolveInput(index, new Set(), "*")` を使い、Dynamic Pack の入力型では探索を制約せず、サブグラフ入力、出力、ネスト、virtual node を含めて最終接続元を解決する。表示用に保持した具体型を探索型へ渡してはならない。
4. `resolved.node` の物理出力スロットから表示名と型を取得する。
5. フィールドキーには Pack 入力の `input.name` を使う。
6. 重複表示名だけを `_2`, `_3` で一意化する。キーは変更しない。
7. Queue 時は widget.value や共有ノードの input/output を変更せず、導出した JSON だけを返す。

Queue 直前に cache が古くても、DTO から直接導出した schema を送ること。UI通知を実行正当性の必須条件にしない。

### `from Dynamic Pipe`

`from` の `_schema` widget にも実行インスタンス対応の `serializeValue` を設定する。

1. `from` の DTO から `dynamic_pipe` 入力を解決する。
2. サブグラフ境界と virtual node を越えて、上流の Pack DTO を探す。
3. Pack DTO に対して `derivePackSchemaForExecution()` を呼ぶ。
4. 同じ schema JSON を `from` の `_schema` として Queue に送る。

これにより、Pack と Unpack のシリアライズ順に依存しない。cache への書込みも Queue 成功の前提にしない。

`serializeValue` が DTO を受け取れない frontend では、既存の widget.value を返す互換フォールバックを残す。その場合は複数インスタンスで異なる型を保証できないため、console に短い警告を1回だけ出す。

## 境界探索

UI同期用の探索関数は、ノードだけでなく実行コンテキストを受け取る。

```js
{
  rootGraph,
  graph,
  instancePath,
  node,
  slot
}
```

探索結果は少なくとも次を含む。

```js
{
  status: "resolved" | "unresolved" | "ambiguous" | "cycle",
  node,
  slot,
  executionId,
  name,
  type
}
```

### 外側から内側へ入る場合

内部リンクの `origin_id === -10` を検出したら通常ノード検索をしない。

1. 現在の `instancePath` から、そのサブグラフ定義を使用している親 `SubgraphNode` インスタンスを特定する。
2. 内部リンクの `origin_slot` に対応する親 `SubgraphNode.inputs[origin_slot]` を取得する。
3. 親入力の外側リンクへ移動する。
4. 物理接続元または次の境界に到達するまで繰り返す。

編集画面の同期では Queue 用 DTO の成功だけに依存しない。表示中インスタンスの `instancePath` を使って、内部 Pack の入力リンクから親 `SubgraphNode.inputs[slot]` と外部リンクを直接逆走し、物理出力の名前と型を取得する。DTO 解決が一時的に失敗しても、この直接探索が成功した schema で Pack 表示、instance cache、同じインスタンスの Unpack を更新する。

フィールド名の所有者は最初に通過するサブグラフ入力スロットとする。外部の物理出力名が `CONDITIONING` でも、境界スロット名が `positive` / `negative` なら schema の `name` はそれぞれその名前を使う。型は外部リンクが接続されていれば最終物理出力型を使い、親入力が未接続ならサブグラフ入力スロット自身の型を使う。親入力の切断だけを理由に名前や型を `"*"` へ戻さない。

境界内リンクの `type === "*"` を最終型として採用しない。最終的な物理出力の `type` を優先する。

### 内側から外側へ出る場合

上流ノードが `SubgraphNode` の出力なら、通常の PIPE 入力探索へフォールバックする前に `resolveSubgraphOutputLink(outputSlot)` を使う。

1. 解決結果の `outputNode` と `link.origin_slot` へ進む。
2. `instancePath` にその `SubgraphNode.id` を追加する。
3. ネストされたサブグラフなら同じ処理を再帰する。

サブグラフ出力と無関係な「接続済み `DYNAMIC_PIPE` 入力が1本」という条件で上流 Pack を選ばないこと。これは誤選択の原因になる。

### virtual node と通常の中継ノード

- `resolveVirtualOutput()` が物理ノードを返す場合は、そのノードオブジェクトとスロットを使う。
- `getInputLink()` が階層付きIDを返す場合、その文字列を現在グラフの `getNodeById()` に渡さない。
- 通常の中継ノードは、接続済み `DYNAMIC_PIPE` 入力が厳密に1本の場合だけ上流へ進む。
- `graph id + instancePath + node id + slot` の visited key で循環を防ぐ。
- 解決不能時は最後の有効な保存 schema を保持する。

## UIで表示するインスタンスの特定

サブグラフ定義のノード表示は共有されるため、内部 `to` のラベルとピン色は「現在開いているインスタンス」の schema を表示する。

1. canvas の `subgraph-opening` / `subgraph-opened` を監視する。
2. event の `detail.fromNode` を使い、ルートからのインスタンスID列を保持する。
3. ネストして開いた場合は現在の列へ `fromNode.id` を追加する。
4. 戻る操作では現在の graph に合う位置まで列を短くする。
5. hash・直接ナビゲーションなどで `fromNode` が得られない場合、ルートから到達可能なインスタンスパスを列挙する。
6. 候補が1つなら採用し、複数なら `ambiguous` として schema を推測しない。

`ambiguous` の場合は保存済み表示を維持する。別インスタンスの schema を勝手に選ばない。

内部ノードの `label`、`dynamicPipeType`、ピン色、リンク色は、現在開いているインスタンスの表示キャッシュとして扱う。サブグラフ入力境界へ接続された内部 Pack の `input.type` と内部リンクの契約型は `"*"` のまま維持する。Queue 用 schema は必ず DTO から生成し、この共有表示状態を参照しない。

## ピン型と色の更新

外部の物理接続元が解決できた場合、現在表示中の Pack 入力に次を適用する。

- `input.label = instanceField.name`
- `input.type = "*"`（サブグラフ入力境界の場合。通常の物理接続では従来どおり実型）
- `input.dynamicPipeType = instanceField.type`
- `input.dynamicPipeConfigured = true`
- `input.color_on` / `input.color_off = LGraphCanvas.link_type_colors[instanceField.type]`

境界入力では型契約と表示色を分離する。ピン色は `color_on` / `color_off` で、リンク色は `link.color` で実型を表示するが、`input.type` と `link.type` は `"*"` から変更しない。具体型に変更すると、次回の `ExecutableNodeDTO.resolveInput()` が BYPASS ノードを具体型で探索し、境界解決に失敗する。

ただし、共有定義の `SubgraphInput.type` をインスタンス固有型で上書きしない。境界スロットの契約を `*` から `IMAGE` へ恒久的に狭めると、別インスタンスの `LATENT` 接続を妨げるためである。

共有ノードに残る型・色は最後に表示したインスタンスの UI キャッシュになり得る。保存・再読込後は、インスタンスコンテキストが確定した時点で必ず再適用する。

## 変更通知と再同期

`notifyConnectedUnpacks()` の同一グラフ走査を、ルートワークフロー単位の context-aware reconciliation に置き換える。

### 監視対象

- ルートグラフと全サブグラフの `node:slot-links:changed`
- `subgraph-created`
- `input-added`, `removing-input`, `renaming-input`
- `output-added`, `removing-output`, `renaming-output`
- virtual source の選択・rename通知
- `afterConfigureGraph`
- `subgraph-opened` と表示インスタンスの切替
- 表示中 Pack の描画時差分検出。通知が欠落した場合だけ、直接境界探索による再同期を1回予約する

イベントは短い delay で1回にまとめる。root graph ごとに `AbortController` を保持し、ワークフローの破棄・再設定時に listener を解除する。

### active reconciliation

ユーザーの接続、切断、差し替えで実行する。

1. ルートから到達可能な全 Subgraph インスタンスパスを列挙する。
2. 各 Pack 実行IDの schema を再導出する。
3. 完全に解決できた schema だけ instance cache を更新する。
4. 各 Unpack から上流 Pack 実行IDを解決し、その schema を適用する。
5. 現在表示中の Pack ピンを active instance schema で再描画する。
6. 明示的な切断で schema が空になった場合だけ、active 操作として空 schema を確定する。
7. 到達不能になった cache entry の削除は、active な構造変更後にだけ行う。

### passive reconciliation

読込、ページ再読込、タブ切替、サブグラフ開閉で実行する。

1. 保存済み widget schema と instance cache を先に復元する。
2. ライブ接続が完全に解決できたエントリだけ更新する。
3. 未解決、曖昧、復元途中の場合は既存 schema と downstream link を維持する。
4. passive 処理では、schema が短く見えるだけで output を削除しない。

### Queue 時の最終保証

通知漏れがあっても、`serializeValue(executableNode)` が対象実行IDの schema を再導出する。UI cache の鮮度と Queue の正しさを分離すること。

## Unpack 出力の更新

現在の `applySchemaToUnpack()` は主に配列位置で出力を照合している。インスタンス schema 対応では `field.key` を識別子として照合する。

1. 既存 output を `output.dynamicPipeKey` で索引化する。
2. 同じ key の output は再利用する。
3. name だけが変わった場合は downstream link を維持する。
4. type が変わった場合だけ、その key の incompatible link を切断する。
5. schema から消えた key の output だけを削除する。
6. 残った key の downstream link を、他フィールドの削除や追加だけで切断しない。
7. 出力順を schema 順にする場合は、再利用した output の `origin_slot` と graph link の `origin_slot` を一緒に更新する。配列だけを並べ替えない。
8. 旧ワークフローで `dynamicPipeKey` がない output は、保存 `_schema` の同位置フィールドで一度だけ対応付ける。

Pack 入力と Unpack 出力の永続的な同一性は表示名ではなく `value_N` key で判断する。

## 旧ワークフローの移行

- instance cache がないワークフローは現行 `_schema` をフォールバックとして読み込む。
- ライブ接続を実行パスごとに解決できた時点で、それぞれの cache entry を作る。
- 1つの旧 schema を全インスタンスへ無条件に複製しない。実接続を解決できないインスタンスでは保存状態を維持する。
- 旧 `_schema`、既存 `value_N`、既存 output slot を削除・改名しない。
- 新しい cache は frontend 専用メタデータであり、Python APIの引数には追加しない。

## Python 側

基本契約は変更しない。

- `ToDynamicPipe.pack()` は Queue から渡されたインスタンス別 `_schema` と `value_N` を現在どおり格納する。
- `FromDynamicPipe.unpack()` は同じインスタンス別 `_schema` の key 順に値を返す。
- pipe 内の `schema` と Unpack の `_schema` の key 列が異なる場合は、現在の missing-key エラーを維持するか、より明確な schema mismatch エラーにする。
- pipe 側 schema を暗黙に優先して出力順を変更しない。frontend の出力スロット順と Python tuple 順がずれるためである。

## 実装単位

主な変更対象は `web/dynamicPipe.js`。`nodes.py` は、必要ならエラーメッセージの明確化だけに留める。

推奨する責務分割:

- `instanceStateFor(rootGraph)`
- `executionPathForActiveCanvas()`
- `enumerateSubgraphInstancePaths(rootGraph)`
- `resolvePhysicalSource(context)`
- `findUpstreamPack(context)`
- `derivePackSchemaForExecution(packDto, mode)`
- `schemaForPackExecutionId(rootGraph, executionId)`
- `installSchemaSerializer(node)`
- `reconcileWorkflow(rootGraph, mode)`
- `bindWorkflowListeners(rootGraph)`

既存の `graphFor()`, `linkFor()`, `rootGraphFor()`, `readPackSchema()`, `parseWidgetSchema()` は再利用する。汎用的でない抽象層は追加しない。

## 必須テスト

### 静的・focused

1. ルート内の直接接続が従来どおり動く。
2. Pack と Unpack が同じサブグラフ内にある場合も動く。
3. 内側 Pack `20:10` から外側 Unpack を解決できる。
4. 外側 `IMAGE` から内側 Pack `20:10` を解決し、schema type が `IMAGE` になる。
5. 親入力を切断しても、内側 Pack の名前と型がサブグラフ入力スロット定義から維持される。
6. `positive` / `negative` の物理出力名が共に `CONDITIONING` でも、schema name は境界スロット名のままになる。
7. 同じ定義の `20:10` に `IMAGE`、`21:10` に `LATENT` を接続し、Queue prompt の両 `_schema` が異なる。
8. ネストされた `20:30:10` と別インスタンスを区別できる。
9. 外側入力を IMAGE から LATENT へ差し替えると、対象インスタンスだけが更新される。
10. 片方を切断しても、もう片方の cache と Unpack output が変化しない。
11. 同じ key の name 変更では downstream link が残る。
12. 同じ key の type 変更では incompatible link だけが切断される。
13. passive restore 中の未解決状態で、保存 output と link が削除されない。
14. virtual node、循環、曖昧な直接ナビゲーションで誤ったインスタンスを選ばない。
15. listener が重複登録されず、workflow 破棄後に残らない。
16. `_schema` widget の数と `widgets_values` の位置が変わらない。

### graphToPrompt / Queue

次の構成を1つのワークフローで作る。

```text
IMAGE  -> Subgraph instance 20 -> inner Pack 10 -> outer Unpack A
LATENT -> Subgraph instance 21 -> inner Pack 10 -> outer Unpack B
```

`app.graphToPrompt()` の結果で以下を確認する。

- `output["20:10"].inputs._schema` が `IMAGE`
- `output["21:10"].inputs._schema` が `LATENT`
- Unpack A と B の `_schema` がそれぞれ対応する Pack と一致
- Pack A/B の `value_1` 接続先が別の物理ソース実行ID

GPUを必要としない INT/STRING の構成でも Queue を実行し、Pack と Unpack の値が混ざらないことを確認する。

### UI・手動

- instance 20 からサブグラフを開くと内部 Pack のピンが IMAGE 色になる。
- root に戻り instance 21 から開くと同じ内部 Pack が LATENT 色になる。
- 外側 Unpack A/B が別々の名前・型で展開される。
- 接続差し替え、切断、Undo/Redo 後に再同期する。
- 保存・再読込、ページ再読込、ComfyUI再起動後も同じ状態になる。
- サブグラフ複製、ネスト、workflow tab 切替後もインスタンスが混ざらない。
- downstream link が同じ key・同じ type のままなら維持される。

静的モックだけで UI色、ブラウザでの復元、Queue実行を完了扱いにしない。

## 完了条件

- 境界の両方向で、物理接続元と Pack 実行IDを正しく解決する。
- 同一サブグラフ定義の複数インスタンスが、それぞれ別の Queue schema を送る。
- 現在開いているインスタンスに対応した内部 Pack のピン型・色を表示する。
- 外側 Unpack が接続先インスタンスの schema だけを展開する。
- 接続変更が境界の反対側まで通知される。
- 保存済みワークフローと `widgets_values` 契約を維持する。
- focused test、`graphToPrompt`、Queue、UI、保存再読込の結果を区別して報告する。
