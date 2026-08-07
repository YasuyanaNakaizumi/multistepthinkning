# 回答中リンク生成仕様（画像リンク & TOC PDFリンク）

本ドキュメントでは、最終回答に含まれる **画像リンク** と **TOC PDFリンク** がどのように生成されるかを、SAS URL生成・参照解決・インライン配置の観点から詳細に説明します。

---

## 1. 共通基盤: SAS URL 生成

すべての Blob Storage 上のファイル（画像・PDF 等）へのダウンロードリンクは、**SAS URL** を通じて発行されます。以下がその仕組みです。

### 関数: `create_sas_url(blob_url)`

| 項目 | 内容 |
|------|------|
| **入力** | `blob_url` — Blob名（container-relative または `https://...` のフルURL） |
| **出力** | SAS付きのフルダウンロードURL（`https://{account}.blob.core.windows.net/{container}/{blob}?{sas_token}`） |
| **失敗時** | 入力 `blob_url` をそのまま返す |

### 処理フロー

```
1. 環境変数から Connection String / Container Name を取得
2. 入力 URL から Blob名を抽出（_extract_blob_name_from_reference）
   - http非開始 → container-relativeパスとしてそのまま使用
   - http開始 → URLパースして /{container}/ 以降を抽出
3. Blob名を URL-decode（unquote）して raw名を得る
4. BlobServiceClient.from_connection_string() でクライアント構築
5. generate_blob_sas() で SASトークン生成
   - permission: read=True
   - expiry: 現在時刻 + 1時間
6. Blob名を URL-encode（quote, safe="/"）してURLパス部分構築
7. base_url + sas_token で完成したURLを返す
```

**重要**: SAS署名は **raw blob名**（URL-decode済み）で生成し、URLパス部分は **URL-encode済み** で構築する。これがブラウザから正しくダウンロードできる鍵。

---

## 2. 画像リンク生成

最終回答内に挿入される画像は、2つの異なる経路で生成されます。

### 2.1 経路A: GPT回答中に直接記述された画像

GPTが System Prompt の指示に従い、以下のようなMarkdown記法で画像を回答本文に書き込みます。

```markdown
![Caption](https://...sas_url...)
```

**System Prompt での指示要約**:
- `![Caption](https://...)` の標準Markdown形式を使用
- URL は `image_paths_list` または `image_explanation` の `URL` フィールドから提供されたもののみ使用
- 提供されたURL以外は発明（ハルシネーション）してはならない
- ステップ/段落に対応する画像を、その直後に即座に挿入
- 末尾に画像をまとめて置くことは禁止

これらの画像URLは、Phase 10（`generate_final_answer`）で **System Prompt の `Context` セクション** にあらかじめ埋め込まれているSAS URLです。

### 2.2 経路B: Pythonによる決定論的インライン挿入

GPTが画像を挿入し忘れた場合や、より正確な配置が必要な場合に、**Python後処理**で強制的に画像を回答テキストに挿入します。

#### 関数: `_inject_all_images_inline()`

**入力**: `answer`（GPTの生回答文字列）+ `all_cropped_images`（辞書リスト）

**`all_cropped_images` の構造（Phase 10で構築）**:

```python
{
    "ref_id": "shop-1",           # どのDocument Refブロック由来か
    "url": "https://...sas_url...", # create_sas_url(path) で生成したSAS URL
    "caption": "...",            # image_content.caption
    "page": 42,                  # image_content.page_number
    "step": "3"                  # image_content.procedure_step_number
}
```

**Phase 10での蓄積経路**:

```
Azure AI Search結果
  └── result["image_content"]
        └── flatten_explanations() → JSONパース
              └── explanation_dict["cropped_image_path"] = "pdfs/processed/.../img.png"
                    └── create_sas_url(cropped_image_path) → SAS URL
                          └── all_cropped_images.append({ref_id, url, caption, page, step})
```

**挿入ロジック**:

```
1. all_cropped_images を ref_id → step(数値) → page でソート
2. 各画像に対して回答テキストの行を走査:
   a) 画像の "step" と一致する行を検索:
      - "3." や "Step 3" や "手順 3" 等のパターンでステップ行を特定
      - かつ、その行または周辺行に同じ ref_id の [shop-N] タグが存在することを確認
        → 異なる章の画像を混在させないためのガード
   b) ステップ行が見つかれば、その直後の行に挿入
      → ![{caption}]({sas_url})
   c) ステップ行が見つからない場合 → スキップ（末尾にまとめることはしない）
3. すでに ![ で始まる行が挿入先の場合は1行下にずらす
```

**CRITICAL**: ステップ行が見つからない画像は **挿入しない**。回答末尾に画像をダンプすることを防ぐ。

---

### 2.3 回答表示時の画像URL解決

GPT回答（またはPython後処理済み回答）に含まれる画像参照は、以下の2つの形式があります。

```markdown
[IMAGE: some/path.png]       ← 旧形式（レガシー）
![Caption](some/path.png)    ← Markdown標準形式
```

**関数**: `display_response()` 内の `_resolve_image_reference()`

| 解決順 | 方法 | 詳細 |
|--------|------|------|
| 1. Exact match | `image_map.get(image_key)` または `image_map.get(unquote(image_key))` | `image_paths` から構築した `{URL: URL}` 辞書で完全一致 |
| 2. Basename match | `image_basename_map.get(os.path.basename(unquote(image_key)))` | `image_paths` から構築した `{basename: URL}` 辞書でファイル名一致 |
| 3. Fuzzy contains match | `_norm_key()` で正規化後、部分一致 | スペース/記号/ハイフン/アンダースコアを正規化した上で contains 判定。最も長い一致スコアを持つURLを採用 |

**解決成功後の表示フロー**:

```
1. _resolve_image_reference(image_key) → full_image_url (SAS URL)
2. _extract_blob_name_from_reference(container_name, full_image_url) → blob_name
3. Blob Storageから blob_client.download_blob().readall() で画像バイナリ取得
4. st.image(image_bytes) で表示
5. create_sas_url(blob_name_raw) で再度SAS URL生成
6. st.markdown("[Download image]({sas_url})") でダウンロードリンクを同時表示
7. displayed_blob_names set で重複画像を防止（同一Blobは2回表示しない）
```

---

## 3. TOC PDFリンク生成

回答文中の参照リンクは、最終的に **[章タイトル](PDFのSASダウンロードURL)** のMarkdownリンクとして表示されます。

### 3.1 `[shop-N]` → `[Title](SAS_URL)` 置換（レガシー / 移行中）

**関数**: `_replace_refs_outside_tables()`（非ストリーミング時） / `_replace_refs_quick()`（ストリーミング時）

**入力**: `answer`（画像インライン挿入済みのMarkdownテキスト）

**事前計算（ストリーミング対応）**:

`generate_final_answer()` 開始時に、全 `chapter_refs` に対して `_build_toc_pdf_blob_name(result)` → `create_sas_url()` を一括実行し、`ref_link_map = {"shop-1": "[Title](SAS_URL)", ...}` を事前構築。これによりストリーミング中の chunk ごとの置換を高速化（ネットワーク通信なし）。

**非ストリーミング時（stream=False）の処理フロー**:

```
1. テキストを行に分割
2. 各行を走査:
   a) "## Related Connector Information" ヘッダーに到達 → in_connector_section = True
   b) "|" で始まる行 → in_table_block = True（テーブル内判定）
   c) Connectorセクション内 または テーブル行 または "|" で始まる行 → 置換しない
   d) 上記以外の通常テキスト行:
      - chapter_refs を走査（{ "shop-1": {title, result, ...} }）
      - 各行中の "[shop-1]" を置換:
        ① result から _build_toc_pdf_blob_name(result) を実行 → PDFのBlobパスを構築
        ② create_sas_url(pdf_blob_path) → SAS付きPDFダウンロードURL
        ③ "[{title}]({sas_url})" に置換
```

**ストリーミング時（stream=True）の処理**:

```
1. GPT から chunk を逐次受信
2. 受信バッファに累積
3. 毎 chunk で _replace_refs_quick(answer_buffer) を実行:
   - ref_link_map を単純な str.replace() で適用
   - テーブル/Connectorセクション判定なし（リアルタイム優先）
4. 置換後のテキストに変化があった場合のみ:
   → st.empty().markdown() で画面更新
   → [shop-N] が出現した瞬間に自動的に [Title](SAS_URL) に変換されて反映される
5. Stream 完了後:
   - _inject_all_images_inline() → _replace_refs_outside_tables() を本番実行
   - st.empty() コンテナを最終更新（テーブル内・Connectorセクション内の除外置換を適用）
```

今後の方針として、`[shop-N]` の置換に依存せず、**GPTが回答本文にSAS URLを直接書く**運用も可能です。
その場合は `Context` 側で「PDFのSAS URL（=章PDFのダウンロードURL）」を明示的に渡し、GPTはそれをそのまま `[...]()` に埋め込みます。

### 3.1.1 Context での URL 提供ルール（重要）

各 `Document Ref` ブロックでは、GPT が混同しないよう以下を**ラベル付きで**提供します。

- `PDF_CITATION_URL: <章PDF の SAS URL>` — **TOCリンク用（.pdf）のみ**
- `PDF_CITATION_MARKDOWN: [章タイトル](<上記URL>)` — そのまま貼るだけで引用リンクになる
- `image_explanation:` 配下の `IMAGE_URL: <画像の SAS URL>` — **画像挿入用（.jpg/.png）のみ**
- `image_paths_list:` — 同一ページ画像の SAS URL 群（画像挿入用のみ）

System Prompt で GPT に対して厳守ルールを課します:
- **引用リンク**は必ず `PDF_CITATION_URL` を**バイト単位でそのまま**使う（SAS トークン含めて改変禁止）。
- **画像**は `IMAGE_URL` または `image_paths_list` の URL のみを使用。`.jpg`/`.png` を引用リンクにしない。
- URL を自分で組み立てない・短縮しない・再エンコードしない。

### 3.2 PDF Blobパスの構築ルール

**関数**: `_build_toc_pdf_blob_name(result)`

**入力**: Azure AI Search結果の辞書（`result`）

**使用するフィールド**:
- `result["document_id"]` — 例: `kgp_documentcenter_shopmanual_japanese_sja04625-14`
- `result["documentNumber"]` — 例: `SJA04625-14`
- `result["path"]` — 例: `00 総目次、まえがき > まえがき、安全、基本情報 > 整備基準用語の解説`
- `result["parent_path"]` — 例: `00 総目次、まえがき > まえがき、安全、基本情報`
- `result["TOC"]` — 例: `整備基準用語の解説`

**構築式（実際のBlob命名規則）**:

```
pdfs/processed/
  {document_folder}
  /chunks/{documentNumber}/
  {chapter_path}.pdf
```

ここで:

- `document_folder`
  - 原則: `result["document_id"]` から「末尾の `_{documentNumber小文字}`」を除いた部分
  - 例: `kgp_documentcenter_shopmanual_japanese_sja04625-14` → `kgp_documentcenter_shopmanual_japanese`
- `chapter_path`
  - 原則: `result["path"]` をそのまま使用（`A > B > C` の形式）
  - `path` が無い/空の場合: `parent_path + " > " + TOC`

補足:
- `chapter_path` の区切りはフォルダ区切りではなく、Blob名の文字列として `" > "` を含むことがあります（実データ準拠）。
- 末尾がすでに `.pdf` の場合は重複付与しない。

**`document_folder` の実在リスト**（コンテナ `aibot` 内の `pdfs/processed/` 直下）:

```
kgp_documentcenter_maintenancemanual_english
kgp_documentcenter_maintenancemanual_french
kgp_documentcenter_maintenancemanual_spanish
kgp_documentcenter_operationandmaintenancemanual_english
kgp_documentcenter_operationandmaintenancemanual_french
kgp_documentcenter_operationandmaintenancemanual_italian
kgp_documentcenter_operationandmaintenancemanual_japanese
kgp_documentcenter_operationandmaintenancemanual_portuguese
kgp_documentcenter_operationandmaintenancemanual_spanish
kgp_documentcenter_operatorsmanual_english
kgp_documentcenter_operatorsmanual_spanish
kgp_documentcenter_shopmanual_chinese
kgp_documentcenter_shopmanual_english
kgp_documentcenter_shopmanual_french
kgp_documentcenter_shopmanual_italian
kgp_documentcenter_shopmanual_japanese
kgp_documentcenter_shopmanual_portuguese
kgp_documentcenter_shopmanual_russian
```

**`document_folder` の導出（擬似コード）**:

```
folder = document_id.toLowerCase()
suffix = "_" + documentNumber.toLowerCase()
if folder.endsWith(suffix): folder = folder.slice(0, -len(suffix))
```

例: `kgp_documentcenter_shopmanual_japanese_sja04625-14` - `_sja04625-14` → `kgp_documentcenter_shopmanual_japanese`

### 3.3 画像 Blobパス

画像は `image_content[*].cropped_image_path` をそのまま使います（形式は既に `pdfs/processed/<folder>/chunks/<documentNumber>/images/<chapter>/<file>.jpg`）。

ルール:
- `cropped_image_path` → `createSasUrl()` で SAS 付与 → `IMAGE_URL` として Context に投入
- GPT は `![caption](IMAGE_URL)` の形でインライン挿入する
- `cropped_image_path` / `IMAGE_URL` は **引用リンクには絶対使わない**

**実例**:

| フィールド | 値 |
|-----------|------|
| documentType | `Shop Manual` → `shopmanual` |
| language | `Portuguese` → `portuguese` |
| documentNumber | `KPBM019109` |
| path | `DIAGN STICO DE FALHAS` |
| TOC | `DIAGN STICO DE FALHAS` |

**出力 Blobパス（例）**:
```
pdfs/processed/kgp_documentcenter_shopmanual_japanese/chunks/SJA04625-14/00 総目次、まえがき > まえがき、安全、基本情報 > 整備基準用語の解説.pdf
```

**実データの他例**:
- `00 総目次、まえがき構成、総目次 > ショップマニュアル構成一覧表.pdf`
- `00 総目次、まえがき構成、まえがき、安全、基本情報 > エンジンに新しく使用しているコネクタの取り扱い.pdf`

このパスを `create_sas_url()` に渡すことで、SAS付きダウンロードURLが生成されます。

---

## 4. リンク生成全体フロー

### Phase 10: `generate_final_answer()` 内でのリンク構築

```
┌──────────────────────────────────────────────────────────────┐
│  Step 1: chapter_refs 構築 + ref_link_map 事前計算           │
│  ─────────────────────────────────────────────────────────   │
│  all_results (main + connector + sub) を走査                │
│  shop-1, shop-2, ... と ref_id を割り当て                     │
│  → chapter_refs[ref_id] = { title: TOC, result: raw_result }  │
│                                                             │
│  同時に ref_link_map 構築:                                   │
│    _build_toc_pdf_blob_name(result) → create_sas_url()       │
│    → ref_link_map[ref_id] = "[Title](PDF_SAS_URL)"          │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 2: all_cropped_images 構築（画像SAS URL蓄積）          │
│  ─────────────────────────────────────────────────────────   │
│  各resultから:                                               │
│    result["image_content"] → flatten_explanations()         │
│      → JSONパース → cropped_image_path 取得                │
│        → create_sas_url(cropped_image_path)                  │
│          → all_cropped_images.append({                      │
│               ref_id, url: sas_url, caption, page, step      │
│             })                                               │
│                                                             │
│  同時に same_page_paths も SAS化して all_image_paths に蓄積 │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 3: combined_context 構築（GPTへのContextブロック）     │
│  ─────────────────────────────────────────────────────────   │
│  各resultを [shop-N] 付きブロックに整形:                      │
│  --- Document Ref: [shop-1] (MAIN) ---                       │
│  pdf_title: {TOC}                                            │
│  chunk_info: ...                                             │
│  context: {content}                                          │
│  image_explanation:                                          │
│    - Caption: ...                                            │
│      URL: {sas_url}    ← ここに画像SAS URLを埋め込む       │
│  image_paths_list:                                           │
│    - {sas_url}           ← same_page_paths の SAS URLも羅列  │
│  --- End of Document Ref: [shop-1] ---                       │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 4: GPT回答生成（stream=True/False）                   │
│  ─────────────────────────────────────────────────────────   │
│  stream=False:                                               │
│    system_prompt + history + user_query → GPT               │
│    → 一括で Markdown回答を受信                              │
│                                                             │
│  stream=True:                                                │
│    stream=True 指定で chunk 逐次受信                        │
│    → 毎 chunk で _replace_refs_quick() を実行              │
│    → テキストに変化があった場合のみ                         │
│      st.empty().markdown() で表示更新                       │
│    → [shop-N] 出現時に自動的に SASリンクに変換              │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 5: Post-processing（Python側）                        │
│  ─────────────────────────────────────────────────────────   │
│  stream=False 時:                                            │
│    ① _inject_all_images_inline(answer, all_cropped_images)   │
│       → ステップ番号一致 + [shop-N] 近傍確認 → 画像インライン挿入│
│    ② _replace_refs_outside_tables(answer)                  │
│       → [shop-N] を [Title](PDF_SAS_URL) に置換            │
│       → テーブル内・Connectorセクション内は置換除外          │
│                                                             │
│  stream=True 時:                                            │
│    Stream完了後、一括で上記①②を実行                        │
│    → st.empty() コンテナを最終更新                          │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 6: display_response()（Streamlit表示）                 │
│  ─────────────────────────────────────────────────────────   │
│  ① [IMAGE: ...] または ![...](...) を正規表現で検索        │
│  ② _resolve_image_reference() → image_map / basename_map   │
│     / fuzzy match でSAS URLを解決                            │
│  ③ Blob Storage から画像バイナリ取得 → st.image() 表示     │
│  ④ 同時に create_sas_url() → [Download image] リンク表示  │
│  ⑤ PDFリンク ([Title](URL)) はそのまま st.markdown() で表示 │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. 重要な制約と注意事項

| 制約 | 内容 |
|------|------|
| **テーブル内 `[shop-N]` は置換しない** | `_replace_refs_outside_tables()` でテーブル行（`\|` で始まる行）はスキップ。テーブルヘッダーセパレーターが破壊されるのを防ぐ |
| **Connectorセクション内も置換しない** | `## Related Connector Information` 以降のセクションでは `[shop-N]` をそのまま残す |
| **画像はステップ行の直後にのみ挿入** | `_inject_all_images_inline()` でステップ行が見つからない画像は挿入しない。末尾ダンプを防ぐ |
| **同一Blobの重複表示防止** | `display_response()` 内で `displayed_blob_names` set で管理 |
| **SAS有効期限は1時間** | `create_sas_url()` で `datetime.now(timezone.utc) + timedelta(hours=1)` |
| **PDFパス構築には4フィールドが必須** | `documentNumber`, `documentType`, `language`, `path` のいずれか欠損時は `_build_toc_pdf_blob_name()` が `None` を返し、リンク生成されない |
| **画像URLは提供されたもののみ** | System Prompt でGPTに指示。提供URL以外のURLを発明しないように制約 |
