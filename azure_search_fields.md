# Azure AI Search フィールド構成と使用状況

## 1. インデックスフィールド一覧

`app.py` 内で定義されている取得対象フィールドと、ベクトル検索対象フィールドを以下に示します。

### 1.1 取得フィールド（SELECT）

```python
SEARCH_FIELDS = [
    "id",
    "TOC",
    "path",
    "content",
    "fileName",
    "start_page",
    "end_page",
    "image_content",
    "same_page_paths",
    "documentNumber",
    "documentTitle",
    "documentType",
    "language"
]
```

| フィールド名 | 型（推定） | 用途概要 |
|-------------|-----------|---------|
| `id` | string | ドキュメントチャンクの一意識別子。重複排除・マージ時に使用 |
| `TOC` | string | 章タイトル。GPTによる章選定の基準、フィルタ検索のキー、回答内の参照タイトル表示に使用 |
| `path` | string | チャンクの階層パス。PDFリンク生成時に使用（`_build_toc_pdf_blob_name`） |
| `content` | string | Markdownテキスト本体。最終回答生成の主要コンテキスト、判定・抽出・分類の全ステップで使用 |
| `fileName` | string | ファイル名（補助情報） |
| `start_page` | int | チャンク開始ページ。最終回答の `chunk_info` 表示に使用 |
| `end_page` | int | チャンク終了ページ。最終回答の `chunk_info` 表示に使用 |
| `image_content` | string / JSON | 各画像の説明情報（caption, ocr_text, label, cropped_image_path等）。画像インライン挿入の判定・SAS URL生成に使用 |
| `same_page_paths` | string / array | 同一ページ内の画像ファイルパス一覧。回答表示時の画像取得に使用 |
| `documentNumber` | string | 文書番号（例: `SEN06867-11`）。Sidebar選択値との紐付け、検索フィルタ、PDFリンク生成に使用 |
| `documentTitle` | string | 文書タイトル（補助情報） |
| `documentType` | string | 文書種別（例: `Shop Manual`）。PDFリンク生成時のパス構築に使用 |
| `language` | string | 言語コード（例: `Japanese`）。PDFリンク生成時のパス構築に使用 |

### 1.2 ベクトル検索対象フィールド（VectorizedQuery）

以下のフィールドは `search_documents()`（ハイブリッド検索）で埋め込みベクトル検索の対象となります。
取得フィールド（SELECT）としては含まれていませんが、検索時に内部的に参照されます。

| フィールド名 | 用途 |
|-------------|------|
| `contentVector` | `content` のテキスト埋め込みベクトル。セマンティック類似検索に使用 |
| `imageSummaryVector` | 画像要約の埋め込みベクトル。画像コンテンツに対するセマンティック検索に使用 |

```python
vector_query = VectorizedQuery(
    vector=vector,
    k_nearest_neighbors=5,
    fields="contentVector,imageSummaryVector"
)
```

---

## 2. 各処理ステップでのフィールド使用状況

### クエリ条件として使用されるフィールド

| フィールド名 | 使用ステップ | 使用方法 |
|-------------|-------------|---------|
| `TOC` | Step 3 (`step3_search_by_toc_filter`) | `$filter`: `TOC eq '章タイトル'` で等値フィルタ検索。複数章は `or` で結合 |
| `documentNumber` | Step 3 (`step3_search_by_toc_filter`) | `$filter`: `documentNumber eq 'SEN06867-11'` で文書絞り込み。`TOC` フィルタと `and` で結合 |
| `documentNumber` | Step 5/6b (`search_documents` ハイブリッド) | `$filter`: 同様に `documentNumber` 等値フィルタを適用 |
| `content` + `contentVector` + `imageSummaryVector` | Step 6b Fallback (`search_documents`) | `search_text` + `vector_queries` でハイブリッド全文・ベクトル検索 |

### 取得結果として使用されるフィールド（SELECT = SEARCH_FIELDS）

すべての Azure AI Search 呼び出しで `select=SEARCH_FIELDS`（または `fields_to_select=SEARCH_FIELDS`）として上記13フィールドを一括取得しています。

---

## 3. ステップ別フィールド使用詳細

### Phase 3 — Step 1: Search Query Generation

| 項目 | 内容 |
|------|------|
| **Azure AI Search使用** | ❌ 不使用（GPTのみ） |
| **使用フィールド** | なし |

---

### Phase 4 — Step 2: Select Relevant TOC Chapters

| 項目 | 内容 |
|------|------|
| **Azure AI Search使用** | ❌ 不使用（GPT + ローカル `md_out_toc/*.md` のみ） |
| **使用フィールド** | なし |

---

### Phase 5 — Step 3: Search by TOC Filter

**関数**: `step3_search_by_toc_filter()`

| 項目 | 内容 |
|------|------|
| **Azure AI Search使用** | ✅ 使用（フィルタ検索、ページング取得） |
| **SELECTフィールド** | `SEARCH_FIELDS` 全13フィールド |
| **クエリ条件（Filter）** | `TOC eq '...'`（章タイトル等値フィルタ） + `documentNumber eq '...'`（文書絞り込み） |
| **search_text** | `"*"`（フィルタのみ、全文検索なし） |
| **vector_queries** | なし |
| **取得結果の使用** | 結果全体を `initial_results` として後続ステップに渡す |

---

### Phase 6 — Step 4: Answerability Judgment

**関数**: `step4_judge_answerability()`

| 項目 | 内容 |
|------|------|
| **Azure AI Search使用** | ❌ 不使用（Step 3の結果を入力としてGPTに判定させる） |
| **結果から使用するフィールド** | `TOC`（章タイトル表示）、`content`（判定用テキスト抜粋の構築） |

---

### Phase 6b — Fallback: Hybrid Search

**関数**: `search_documents()`（フォールバック時に `run_multi_step_reasoning` から呼び出し）

| 項目 | 内容 |
|------|------|
| **Azure AI Search使用** | ✅ 使用（ハイブリッド検索） |
| **SELECTフィールド** | `SEARCH_FIELDS` 全13フィールド |
| **クエリ条件（Filter）** | `documentNumber eq '...'`（文書絞り込み。`selected_pdfs` 指定時） |
| **search_text** | ユーザーの検索クエリ文字列（`query_text`） |
| **vector_queries** | `VectorizedQuery` → `fields="contentVector,imageSummaryVector"`（ベクトル検索） |
| **取得結果の使用** | `id` で重複排除後、`initial_results` にマージ |

---

### Phase 7 — Step 5a: Extract Elements with GPT

**関数**: `extract_elements_with_gpt()`

| 項目 | 内容 |
|------|------|
| **Azure AI Search使用** | ❌ 不使用（Step 3/6bの結果を入力としてGPTに要素抽出させる） |
| **結果から使用するフィールド** | `TOC`（`found_titles` リスト構築、エラーコード除外判定）、`content`（GPTへの全文テキスト `text_context` 構築） |

---

### Phase 8 — Step 5b: Additional Search

**関数**: `search_additional_documents()`

| 項目 | 内容 |
|------|------|
| **Azure AI Search使用** | ✅ 使用（内部で `step3_search_by_toc_filter()` を呼び出し） |
| **SELECTフィールド** | `SEARCH_FIELDS` 全13フィールド |
| **クエリ条件（Filter）** | `TOC eq '...'`（追加選定された章タイトル） + `documentNumber eq '...'`（文書絞り込み） |
| **search_text** | `"*"`（フィルタのみ） |
| **取得結果の使用** | `_search_type = "additional_toc"` タグを付与して `additional_results` として返却 |

---

### Phase 9 — Step 5c: Chapter Classification

**関数**: `classify_chapters_with_gpt()`

| 項目 | 内容 |
|------|------|
| **Azure AI Search使用** | ❌ 不使用（Step 3/5bの結果を入力としてGPTに分類させる） |
| **結果から使用するフィールド** | `id`（重複排除）、`TOC`（タイトル表示）、`content`（テキストサマリー構築、12,000文字上限）、`image_content`（画像説明の抽出・JSONパース） |

---

### Phase 10 — Step 6 Final: Generate Final Answer

**関数**: `generate_final_answer()`

| 項目 | 内容 |
|------|------|
| **Azure AI Search使用** | ❌ 不使用（分類済み結果を入力としてGPTに回答生成させる） |
| **結果から使用するフィールド** | |
| `TOC` | 章タイトル表示、`[shop-N]` 参照リンクのテキスト |
| `content` | 回答コンテキストのメインテキスト本体 |
| `start_page`, `end_page` | `chunk_info`（part_index / part_count）として表示 |
| `image_content` | `flatten_explanations()` → caption, ocr_text, label_list, md_anchor_quotes, procedure_step_number, page_number, cropped_image_path を抽出。画像インライン挿入判定・SAS URL生成に使用 |
| `same_page_paths` | 画像パス → `create_sas_url()` → `all_image_paths`（回答表示時の画像参照解決） |
| `documentNumber`, `documentType`, `language`, `path` | `_build_toc_pdf_blob_name()` でPDF Blobパスを構築 → `create_sas_url()` で `[shop-N]` 参照リンクのダウンロードURL生成 |

---

### Phase 11 — 回答表示

**関数**: `display_response()`

| 項目 | 内容 |
|------|------|
| **Azure AI Search使用** | ❌ 不使用（既に生成された回答テキストと画像パスを表示） |
| **結果から使用するフィールド** | `same_page_paths` / `cropped_image_path`（Phase 10で処理済みのSAS URLとして `image_paths` に蓄積済み）→ `_resolve_image_reference()` でBlob Storageから画像取得・表示 |

---

### Phase 12 — フォローアップ表示 & 再実行

| 項目 | 内容 |
|------|------|
| **Azure AI Search使用** | ❌ 不使用（UIイベントのみ） |
| **結果から使用するフィールド** | なし |

---

## 4. サマリーテーブル

### フィールド別・使用ステップ一覧

| フィールド | Step 3<br>TOC Filter | Step 6b<br>Hybrid | Step 5b<br>Additional | 回答生成<br>(GPT入力) | PDFリンク<br>生成 | 画像表示 |
|-----------|:------------------:|:-----------------:|:-------------------:|:-------------------:|:---------------:|:--------:|
| `id` | ✅ SELECT | ✅ SELECT | ✅ SELECT | ✅ 重複排除 | ❌ | ❌ |
| `TOC` | ✅ **FILTER** | ❌ | ✅ **FILTER** | ✅ タイトル/参照 | ❌ | ❌ |
| `path` | ✅ SELECT | ✅ SELECT | ✅ SELECT | ❌ | ✅ PDFパス構築 | ❌ |
| `content` | ✅ SELECT | ✅ SELECT | ✅ SELECT | ✅ 主要コンテキスト | ❌ | ❌ |
| `fileName` | ✅ SELECT | ✅ SELECT | ✅ SELECT | ❌ | ❌ | ❌ |
| `start_page` | ✅ SELECT | ✅ SELECT | ✅ SELECT | ✅ chunk_info | ❌ | ❌ |
| `end_page` | ✅ SELECT | ✅ SELECT | ✅ SELECT | ✅ chunk_info | ❌ | ❌ |
| `image_content` | ✅ SELECT | ✅ SELECT | ✅ SELECT | ✅ 画像説明抽出 | ❌ | ❌ |
| `same_page_paths` | ✅ SELECT | ✅ SELECT | ✅ SELECT | ✅ SAS URL生成 | ❌ | ✅ 画像取得 |
| `documentNumber` | ✅ **FILTER** | ✅ **FILTER** | ✅ **FILTER** | ❌ | ✅ PDFパス構築 | ❌ |
| `documentTitle` | ✅ SELECT | ✅ SELECT | ✅ SELECT | ❌ | ❌ | ❌ |
| `documentType` | ✅ SELECT | ✅ SELECT | ✅ SELECT | ❌ | ✅ PDFパス構築 | ❌ |
| `language` | ✅ SELECT | ✅ SELECT | ✅ SELECT | ❌ | ✅ PDFパス構築 | ❌ |
| `contentVector` | ❌ | ✅ **VECTOR** | ❌ | ❌ | ❌ | ❌ |
| `imageSummaryVector` | ❌ | ✅ **VECTOR** | ❌ | ❌ | ❌ | ❌ |

### 凡例

- **FILTER**: `$filter` クエリパラメータとして検索条件に使用
- **SELECT**: `select` パラメータで取得結果として返すフィールド
- **VECTOR**: `vector_queries` / `VectorizedQuery` の対象フィールド（セマンティック検索）
- **GPT入力**: GPTへのプロンプト構成に使用（Azure AI Search自体は使用しないが、Search結果のフィールド値を利用）
- **PDFリンク生成**: `_build_toc_pdf_blob_name()` でPDFダウンロードURLを構築
- **画像表示**: `display_response()` で画像を取得・レンダリング
