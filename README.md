# umakiちゃんの 炭火うなぎ亭 / Umaki's Charcoal Eel House

**▶ 遊ぶ / Play: https://hashimoshi15.github.io/umaki-sumibi-unagitei/**

ログイン不要・インストール不要。スマホ（横向き）やパソコンのブラウザで、そのまま遊べます。
No login, nothing to install: open the link in a phone (landscape) or desktop browser.

- バージョン / Version: 0.6.1（build 0.6.1-202610170032）
- 言語 / Languages: 日本語 · English · 한국어 · 简体中文 · 繁體中文（ブラウザの言語で始まり、タイトルで切り替えられます）
- 1回 約2分 / about 2 minutes a round

## あそびかた / How to play

最初の画面で 言語・ニックネーム・国／地域 を選んで「ゲームスタート」。
うなぎを捌いて串を打ち、炭火で白焼き、タレに沈めて焼き付け、三つに切ってお重へ。ドラッグとタップだけで遊べます。

Choose a language, a nickname and your country / region, then press Start. Fillet the eel, skewer it,
grill it over charcoal, dip it in the tare and set the glaze, then cut it into three and lay it in the box.
Drag and tap only.

- スタートすると、対応するブラウザでは全画面・横向きになります（iPhone の Safari などでは全画面にならず、画面いっぱいで遊べます）。
- ゲームはいつも横画面です。スマホを縦に持ったままでも横画面で表示されるので、スマホを横にして遊んでください（入口の入力だけは縦のままでできます）。
- On Start, browsers that allow it switch to full screen in landscape; others (e.g. Safari on iPhone) play in the full visible window.
- The game is always landscape: on a phone held upright it is drawn sideways, so turn the phone to play (only the entry form stays upright for typing).

## 試遊版の確認範囲 / Trial status

2026-10-17: Codexの独立確認でマウス全工程74点、タッチ相当の合成入力72点、4サイズの盛り付け操作、5言語×4サイズの停止メニューを確認。スマホ実機・Safari・Firefox・音の聴感・長時間運用は未確認。クラウドの音声停止試験に断続的な1失敗が残りますが、単独ローカルブラウザでは回転3回とも約0.12秒で停止しました。全端末での解消を保証するものではありません。

店舗別・全店舗集計は本番未接続です。UEで制作した素材はまだ含まれていません。今回はThree.jsによる試遊版で、実写リアル版の全要件完了ではありません。

Desktop mouse and simulated touch flows were checked independently. Physical phones, Safari/Firefox, audible sound, and long-term operation remain unverified. Production analytics and Unreal Engine assets are not included.

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
