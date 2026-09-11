# CSSの共通化と圧縮を一緒に最適化する

同じ表示を表すCSSでも、gzip/Brotliの入力は文字列です。共通宣言を抽出すると
未圧縮サイズは減りますが、セレクター列、文字列の距離、周辺の並びも変わります。
元の宣言の繰り返しが圧縮辞書に効いていた場合、抽出だけでは圧縮後に増えることが
あります。順序も含めて比較する必要があります。

## 調べた一次資料

- [Hague, Lin, Hong: CSS Minification via Constraint Solving](https://anthonywlin.github.io/papers/toplas19.pdf)
  はセレクターと宣言の共有を、カスケードによる順序制約と分離してモデル化しています。
  論文の文字数ベースの目的関数を、そのまま圧縮サイズの最適性とは解釈できません。
  今回はこの制約の分離を参考にし、候補全体の実圧縮を評価に使います。
  SAT/SMTソルバーの実装や、大域的最適性の証明をしたものではありません。
- [Ben Frain: ECSS chapter 9](https://ecss.benfrain.com/chapter9.html)
  は宣言順によってgzipサイズが変わる実測を示しています。ただし改善は小さく、
  他のCSSやBrotliにも同じ順位が当てはまるとは限りません。
- [DEFLATE RFC 1951](https://www.rfc-editor.org/rfc/rfc1951) は文字列一致の長さと
  後方距離の符号化を規定しています。[Brotli RFC 7932](https://www.rfc-editor.org/rfc/rfc7932)
  はリテラルの文脈や距離のモデルも規定しています。表示上の意味が同じことから、
  これらの有限の圧縮器の出力サイズが同じだとは言えません。
- [cssnano changelog](https://github.com/cssnano/cssnano/blob/master/packages/cssnano/CHANGELOG.md)
  の宣言ソーターを標準presetから外した変更は、新しいCSSプロパティによる
  shorthand/longhandの干渉を見落とす危険を説明しています。未知のプロパティを
  独立だと推定せず、既知プロパティの閉じた集合と順序障壁を採用しました。

## 実装の判断

1. 未圧縮バイトを減らすN-way共有候補だけでなく、途中段階と部分共有も残す。
2. 宣言間のreset、同じ詳細度で重なり得るルール、条件付きunit、fallback、
   未知構文を順序制約として維持する。その範囲で宣言順とルールの近接配置を変える。
3. 固定のアルファベット順だけに依存せず、決定的な優先順位の入れ替えと、
   「共有後に再配置」の候補を実圧縮する。
4. gzip level 6・Brotli quality 11 generic・未圧縮のいずれも基準を超えない候補から、
   gzip+Brotliが最小のものを選ぶ。探索には回数・バイト数の上限を設ける。
5. Viteの後段minifierが順序を変えるため、標準Lightning CSSの設定を反映した
   minify後の文字列で評価する。選んだ入力を通常のVite処理へ渡し、asset hashと
   inline抽出を一貫させる。命名後のCSS assetは書き換えない。

圧縮後の最適化では、共有量を最大にする必要はありません。入力によっては共有の
少ない候補が選ばれます。複数packを結合した結果やHTML全体の圧縮までを保証する
ものでもありません。

## 検証用データ

`packages/vite/src/fixtures/compression-studio.css` は実ページ由来の生成CSSです。
同じ入力をViteの通常ビルドに通し、最適化あり／なしの配信CSS、inline文字列、
content hash、決定性と圧縮サイズを比較する回帰テストを用意しています。
CSS単体の診断は `node scripts/measure-css-dedup.mjs <file.css>` で再現できます。

単体診断では、元CSSの 15,925 / 3,684 / 3,184 bytes（未圧縮 / gzip / Brotli）が、
順序探索により 15,925 / 3,639 / 3,143 bytes になりました。ただし、この宣言順は
Viteのminifierに戻されるため、本番での改善値としては扱いません。
この検出が、minify後の文字列を目的関数に含めた理由です。

Lightning CSSのtargets未指定の独立検証では、minify後の元CSS
15,912 / 3,665 / 3,158 bytes に対し、共有と再配置を組み合わせた候補が
15,621 / 3,650 / 3,137 bytes になりました。Chromiumで同じ実ページに両者を
適用し、画面幅390 / 768 / 1440px × 通常 / ボタンhoverの1,494要素分について、
通常要素と`::before`・`::after`のcomputed styleが一致しました。
これはそのページと状態での検証であり、全CSSの等価性証明ではありません。

Vite 8.2.2の実ビルド（`cssMinify: true`）で最終CSS assetを比較した結果は次のとおりです。

| 最終CSS | 未圧縮 | gzip | Brotli |
| --- | ---: | ---: | ---: |
| 最適化なし | 15,925 | 3,684 | 3,184 |
| 共有＋順序探索 | 15,768 | 3,662 | 3,165 |

値はbytesで、比較のためasset末尾の改行を除いています。これは実ビルドの回帰テストと
同じ条件です。元のCSSは既に圧縮が効いており、改善はgzipで約0.60%、Brotliで約0.60%に
とどまります。上記の独立したminifier比較とはパイプラインの処理が異なるため、数値を
混同しないでください。
