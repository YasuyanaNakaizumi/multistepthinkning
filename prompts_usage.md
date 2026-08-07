# app.py 内 GPT プロンプト一覧と使用タイミング

このドキュメントは `app.py` 内で Azure OpenAI（GPT5.2-chat）に対して送信される **System Prompt** および **User Prompt** を、処理フローのどのタイミングで使用しているかと共に整理したものです。

---

## 全体フロー概要

```
[ユーザー入力]
  └── Step 1: Search Query Generation
  └── Step 2: Select Relevant Chapters from TOC
  └── Step 3: Search by TOC Filter（Azure AI Search、GPT不使用）
  └── Step 4: Answerability Judgment
        ├── 判定 = True  → Step 5（Shared）へ
        └── 判定 = False → Step 6: Hybrid Search（Azure AI Search、GPT不使用）後、Step 5（Shared）へ
  └── Step 5（Shared）:
        ├── 5a. Extract Elements with GPT
        ├── 5b. Additional Search（必要時）
        └── 5c. Chapter Classification (MAIN / SUB / CONNECTOR)
  └── Step 6（Final）: Generate Final Answer
```

---

## 1. Step 1 — Search Query Generation

### 使用タイミング
ユーザーが入力した質問を受け取った直後。Azure AI Search に投げる検索クエリを生成・整形するために使用。

### 関数
`step1_generate_search_queries()`

### System Prompt
```
You are a search query extraction assistant.
```

### User Prompt 概要
- 役割: "You are a search query generator for technical manuals."
- 指示:
  - エラーコード・部品番号・TSI・PSN 等の識別子が含まれていれば、それぞれを独立したクエリとして抽出する
  - 該当しない場合は元の質問文をそのまま1つのクエリとする
  - JSON 形式で出力
- 含まれる変数:
  - `user_query`: ユーザーの生の質問文

### 出力フォーマット（期待）
```json
{
  "queries": ["CA441", "DX6537"],
  "has_codes": true
}
```

---

## 2. Step 2 — Select Relevant Chapters from TOC

### 使用タイミング
Step 1 で生成された `queries` を元に、`md_out_toc` ディレクトリ内の目次（TOC） Markdown から関連する章タイトルを選定する際。

### 関数
`step2_select_toc_chapters()`

### System Prompt
```
You are a technical manual chapter selection assistant.
```

### User Prompt 概要
- 役割: "You are an expert at finding relevant chapters in technical manuals."
- 指示:
  - 提供された TOC の中から、ユーザーの質問・検索クエリに最も関連する章タイトルを最大10件選ぶ
  - 葉レベル（最も具体的な）章を親章より優先
  - エラーコード等が含まれる場合は診断/troubleshooting 章を優先
  - JSON 形式で出力
- 含まれる変数:
  - `user_query`: ユーザーの質問文
  - `queries`: Step 1 で生成されたクエリリスト（JSON）
  - `toc_content`: `md_out_toc/*.md` から読み込んだ目次全文

### 出力フォーマット（期待）
```json
{
  "chapters": ["How to Remove Front Window Assembly", "Boom Speed or Power is Low"]
}
```

---

## 3. Step 4 — Answerability Judgment

### 使用タイミング
Step 3 で TOC フィルタ検索を行い `initial_results` を取得した後、その検索結果で「ユーザーの質問に答えられるか」を判定する際。

### 関数
`step4_judge_answerability()`

### System Prompt
```
You are a document relevance judge.
```

### User Prompt 概要
- 役割: "You are judging whether the provided document excerpts contain enough information to answer the user's question."
- 指示:
  - 提供された文書抜粋に核心情報が含まれていれば `"yes"`
  - 明らかに不十分または無関係であれば `"no"`
  - JSON 形式で出力
- 含まれる変数:
  - `user_query`: ユーザーの質問文
  - `queries`: Step 1 のクエリリスト
  - `context`: 検索結果から構成した章別テキスト抜粋（最大10件）

### 場合分け
| 判定結果 | 遷移先 |
|---|---|
| `answerable: true` | Step 5（Shared）へ |
| `answerable: false` | Step 6: Hybrid Search（上位5件をベクトル検索） → 結果を `initial_results` にマージ後、Step 5（Shared）へ |

---

## 4. Step 5a — Extract Elements with GPT

### 使用タイミング
Step 3（および必要に応じて Step 6）で取得した `initial_results` から、さらに深掘り検索すべき要素（エラーコード、コネクタ、参照章、診断章、部品）を抽出する際。**追加検索の要否判定も同時に行う。**

### 関数
`extract_elements_with_gpt()`

### System Prompt
```
You are an expert in analyzing technical documents. Extract elements written in both Japanese and English.
```

### User Prompt 概要
- 役割: "You are an assistant analyzing technical documents."
- 抽出対象:
  1. `error_codes`: 現在のテキストで詳細が不足しているエラーコード
  2. `connectors`: ピン配線図や配置図が不足しているコネクタID
  3. `reference_chapters`: 他章への明示的参照（see / refer to / 〜を参照 等）
  4. `diagnostic_chapters`: 該当問題のトラブルシュート専用章
  5. `components`: 主要な機械・電気部品（最大2件）
  6. `reasoning`: 現状の情報と不足情報の説明
  7. `needs_followup`: **追加検索が必要かどうかの真偽値**
- `needs_followup = true` となる条件（CRITICAL）:
  - ユーザーのクエリが「故障診断・点検手順・トラブルシュート・inspection・check procedure」等の場合に限定
  - かつ、(a) 現在のテキストが不十分 **または** (b) 抽出要素（reference_chapters / diagnostic_chapters / connectors / error_codes）がある場合
- 含まれる変数:
  - `user_query`: ユーザーの質問文
  - `text_context`: 検索結果から構築したドキュメント全文
  - `chat_history`: 直近4ターンまでの会話履歴（存在する場合）

### 場合分け
| `needs_followup` | 遷移先 |
|---|---|
| `true` | Step 5b: Additional Search（TOC ベースの追加検索）へ |
| `false` | Step 5c: Chapter Classification へ（追加検索をスキップ） |

### 追加ルール
- `needs_followup` は以下の場合に true:
  - 故障診断/点検/トラブルシュート系の質問、または Failure Code（例: `CA441`）が含まれる
  - もしくは抽出要素（`error_codes` / `connectors` / `reference_chapters` / `diagnostic_chapters`）が1つでも存在する

---

## 5. Step 5b — Additional Search（GPT 使用部分のみ）

### 使用タイミング
`extract_elements_with_gpt()` で `needs_followup` が true の場合に、追加で関連章を TOC から選定する際。

### 関数
`search_additional_documents()` 内の GPT 呼び出し部分

### System Prompt
```
You are a technical manual chapter selection assistant.
```
※ Step 2 と同一

### User Prompt 概要
- 役割: "You are an expert at finding relevant chapters in technical manuals."
- 指示:
  - 抽出された要素（エラーコード、コネクタ、参照章、診断章、部品）に基づき、TOC から関連章を **最大50件** 選定
  - **Exhaustive（網羅的）に選ぶ**（保守的であってはならない）
  - エラーコードごとに該当 TOC エントリをすべて含める
  - コネクタ検索時は関連する 3D 配置図シリーズすべてを含める（(1), (2), (3)...）
  - 診断/点検系の場合は前提章（故障診断前の点検要領 等）も含める
  - 部品に対しては取り外し/取り付け章すべてを含める
  - JSON 形式で出力
- 含まれる変数:
  - `deduped_queries`: 要素から生成された追加検索クエリリスト
  - `toc_content`: `md_out_toc/*.md` から読み込んだ目次全文

### 出力フォーマット（期待）
```json
{
  "chapters": ["Chapter A", "Chapter B"]
}
```

---

## 6. Step 5c — Chapter Classification (MAIN / SUB / CONNECTOR)

### 使用タイミング
Initial Results + Additional Results をマージ・重複排除した後、最終回答生成に先立って各章の役割を分類する際。

### 関数
`classify_chapters_with_gpt()`

### System Prompt
```
You are an expert in classifying technical documents.
```

### User Prompt 概要
- 役割: 章リストを `MAIN (Primary Info)` / `SUB (Supplementary Info)` / `CONNECTOR (Connector Info & Location)` / `IGNORE (Exclude)` に分類
- 分類基準:
  - **MAIN**: 質問への直接的な回答・手順・仕様を含む核心章
  - **SUB**: MAIN を補助する補足章（最大5件まで）
  - **CONNECTOR**: コネクタ一覧表・コネクタ立体配置図等（コネクタ関連時は必ず含める）
  - **IGNORE**: 質問と完全に無関係な章
- 重要ルール:
  - ユーザーの質問に含まれるキーワード（エラーコード、部品名等）を含む章は **絶対に MAIN**（IGNORE にしてはならない）
  - 同一内容が複数ある場合は詳細な方を MAIN に
- 含まれる変数:
  - `user_query`: ユーザーの質問文
  - `chapter_list`: 章のインデックス・タイトル・テキストサマリー（画像説明含む）の JSON リスト

### 出力フォーマット（期待）
```json
{
  "main": [0, 1],
  "connector": [4],
  "sub": [2],
  "ignore": [3]
}
```
（配列要素は `chapter_list` のインデックス番号）

---

## 7. Step 6（Final）— Generate Final Answer

### 使用タイミング
分類済みの検索結果（MAIN / CONNECTOR / SUB）を元に、ユーザーへの最終回答を生成する際。

### 関数
`generate_final_answer(user_query, classified_results, elements, chat_history=[], stream=False)`

### 動作モード
- **stream=False（デフォルト）**: GPT から一括で回答を受信し、Python 後処理（画像インライン挿入 + `[shop-N]` SAS URL 置換）を一括実行
- **stream=True**: GPT から chunk 逐次受信。**毎 chunk** で事前計算済みの `ref_link_map`（`_build_toc_pdf_blob_name` → `create_sas_url` の一括実行結果）を用いた高速置換（`_replace_refs_quick`）を実行し、**置換後のテキストに変化があった場合のみ** `st.empty().markdown()` で画面更新。これにより `[shop-N]` が出現した瞬間に自動的に `[Title](SAS_URL)` に変換されて反映される。Stream 完了後に本番の後処理（`_inject_all_images_inline` → `_replace_refs_outside_tables`）を実行して最終表示を更新。

### System Prompt
```
You are an assistant supporting a mechanical engineer.
```
※ ただし、実際には非常に詳細な指示が続く多段階プロンプト。以下に構成を示す。

### System Prompt の主要セクション
1. **Role**: 提供された文書（テキスト・画像）を統合して包括的・正確に回答すること
2. **Answer Creation Rules**（11項目）:
   - 完全性: 手順のすべてのステップ、数値（トルク、クリアランス、部品番号）を含める
   - 安全: 警告（▼）・注意（!）を関連ステップで明記
   - 参照タグ: **すべての主張・手順・技術値に `[shop-N]` を付与**（クリティカル）
   - 章の混在禁止: 異なる章の手順を1ステップに混ぜてはならない
   - ハルシネーション禁止: 提供された Context に明示的にない事実は書かない
   - 詳細性: 長くなっても詳細に書く（目的、観察事項、工具/条件等）
   - 構成: Overview → Preconditions → Procedure → Decision/Diagnosis → Verification After Repair
   - 数値/表の省略禁止: 範囲・工具・重量・コネクタピン数・部品番号等はすべて維持
   - コネクタ表: 該当時は "## Related Connector Information" ヘッダー下にテーブルを出力
   - 画像挿入: コネクタ表直後に配置図画像を挿入（`![Caption](https://...)`）
   - 工具サマリ: 最後に "## Required Tools" テーブルを出力
3. **Image Insertion Rules**（5項目）:
   - 説明する文/ステップの直後に即座に挿入
   - Markdown 形式 `![Caption](https://...)` で記載（URL は提供されたもののみ使用）
   - `image_explanation` の URL を優先使用（`cropped_image_path` 由来）
   - 明らかに該当ステップと一致する画像のみ使用
   - 関連クロップ画像は省略せず、対応ステップ近くにインライン配置（末尾グループ化禁止）
4. **Context**: 検索結果から構築された `[shop-N]` 付き文書ブロック全文

補足（リンク生成方針）:
- PDFリンク/画像リンクは、**Context に含まれるSAS URLをそのまま使用して本文に書く**。
- モデルはURLを生成・推測してはならない（ハルシネーション禁止）。
- TOC PDFのSAS URLは、`document_id` と `path`（または `parent_path` + `TOC`）から構築される章PDFに対応するものが、Context内で提示される。

### User Prompt
```
{user_query}
```
※ ユーザーの生の質問文のみ。ただし `chat_history`（直近4ターンまで）が `messages` 配列として先行して送信される。

### 補足: 場合分け（Connector Rule）
`elements.get("connectors")` が存在する場合、System Prompt に以下の追加ルールが動的に挿入される:
- "## Related Connector Information" ヘッダー下にコネクタ情報テーブルを出力
- 各行に `[shop-N]` 参照タグを付与
- テーブル直後に 3D 配置図等の関連画像を挿入

---

## プロンプト使用タイミング総合表

| ステップ | 関数名 | System Prompt | User Prompt 主要変数 | GPT 使用目的 |
|---|---|---|---|---|
| Step 1 | `step1_generate_search_queries` | search query extraction assistant | user_query | 検索クエリ生成・識別子抽出 |
| Step 2 | `step2_select_toc_chapters` | technical manual chapter selection assistant | queries, user_query, toc_content | TOC から関連章選定 |
| Step 4 | `step4_judge_answerability` | document relevance judge | user_query, queries, search_results | 検索結果で回答可能か判定 |
| Step 5a | `extract_elements_with_gpt` | expert in analyzing technical documents | user_query, text_context, chat_history | 深掘り要素抽出・追加検索要否判定 |
| Step 5b | `search_additional_documents`（内） | technical manual chapter selection assistant | deduped_queries, toc_content | 追加検索のための TOC 章選定 |
| Step 5c | `classify_chapters_with_gpt` | expert in classifying technical documents | user_query, chapter_list | MAIN/SUB/CONNECTOR/IGNORE 分類 |
| Step 6 | `generate_final_answer` | assistant supporting a mechanical engineer | user_query, chat_history, combined_context | 最終回答生成（参照タグ・画像挿入） |

---

## 備考

- `response_format={"type": "json_object"}` が指定されている呼び出し: Step 1, Step 2, Step 4, Step 5a, Step 5b, Step 5c
- Step 6（Final Answer）は JSON 指定なし（自由形式の Markdown 回答を期待）
- Step 5a の `needs_followup` 判定により、Step 5b が **スキップされる場合あり**
- Step 4 で `answerable = false` の場合、Step 6: Hybrid Search（Azure AI Search）が実行されてから Step 5（Shared）に進む
