# umakiちゃんの 炭火うなぎ亭 / Umaki's Charcoal Eel House

**▶ 遊ぶ / Play: https://hashimoshi15.github.io/umaki-sumibi-unagitei/**

ログイン不要・インストール不要。スマホ（横向き）やパソコンのブラウザで、そのまま遊べます。
No login, nothing to install: open the link in a phone (landscape) or desktop browser.

- バージョン / Version: 0.4.0（build 0.4.0-202610151836-p1）
- 言語 / Languages: 日本語 · English · 한국어 · 简体中文 · 繁體中文（ブラウザの言語で始まり、タイトルで切り替えられます）
- 1回 約2分 / about 2 minutes a round

## あそびかた / How to play

最初の画面で 言語・ニックネーム・国／地域 を選んで「ゲームスタート」。
うなぎを捌いて串を打ち、炭火で白焼き、タレに沈めて焼き付け、三つに切ってお重へ。ドラッグとタップだけで遊べます。

Choose a language, a nickname and your country / region, then press Start. Fillet the eel, skewer it,
grill it over charcoal, dip it in the tare and set the glaze, then cut it into three and lay it in the box.
Drag and tap only.

- スタートすると、対応するブラウザでは全画面・横向きになります（iPhone の Safari などでは全画面にならず、画面いっぱいで遊べます）。
- On Start, browsers that allow it switch to full screen in landscape; others (e.g. Safari on iPhone) play in the full visible window.

## データについて / Your data

ニックネームと国／地域は、その端末のブラウザの中だけで使います。サーバーへの送信、ランキング、解析タグはありません。
The nickname and country / region stay in your browser on that device. Nothing is sent to a server; no ranking, no analytics.

## 公開のしかた / Publishing (maintainers)

1. このリポジトリを public で GitHub に置く（ゲームの配布物だけが入っています）。
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**（`.github/workflows/pages.yml` が main への push ごとに公開します）。
   ※ Actions を使わない場合は Source: Deploy from a branch → `main` / `/ (root)` でも同じ内容が公開されます。
3. 公開先: https://hashimoshi15.github.io/umaki-sumibi-unagitei/ （リポジトリ名とアカウントが同じなら、更新してもURLは変わりません）

## ライセンス / Licences

| 素材 / Asset | ライセンス / Licence |
|---|---|
| three.js 0.186.1（game.js に同梱 / bundled） | MIT — `THREE-LICENSE.txt` |
| M PLUS Rounded 1c ExtraBold（使う文字だけのサブセット / subset）`assets/fonts/umaki-round.woff2` | SIL Open Font License 1.1 — `assets/fonts/OFL.txt` |
| umakiちゃんの絵 / Umaki artwork `assets/umaki/*`, `assets/icon-*` | 制作者本人のキャラクター素材 / the author's own character artwork (not licensed for reuse) |
| 料理・道具の質感、効果音 / textures, sounds | 実行時にプログラムで生成 / generated in code at run time |

韓国語・中国語の文字は端末のフォントで表示します / Korean and Chinese text uses the device's own fonts.


## 試遊版の確認範囲とソース

ビルド: `0.4.0-202610151836-p1`。UE素材は未使用。実機iPhone/Android・音の聴感は未確認。
編集可能な検証候補のソースは `source/`。`cd source && npm install && npm test && npm run build` で `outputs/unagi-web/` に再ビルドします。ビルド時刻は新しくなります。公開更新には検証後のビルドをリポジトリ直下へ反映します。開発中の次版の変更は含みません。
