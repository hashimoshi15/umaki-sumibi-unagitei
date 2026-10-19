# umakiちゃんの 炭火うなぎ亭 / Umaki's Charcoal Eel House

**▶ 遊ぶ / Play: https://hashimoshi15.github.io/umaki-sumibi-unagitei/**

ログイン不要・インストール不要。スマホ（横向き）やパソコンのブラウザで、そのまま遊べます。
No login, nothing to install: open the link in a phone (landscape) or desktop browser.

- バージョン / Version: 0.7.3（build 0.7.3-202610191121）
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

## データについて / Your data

「集計に参加する（任意）」にチェックしたプレイだけ、店舗ごとの集計のため、ニックネーム（本名でなくてよい）・国／地域・お店・ゲームの開始と完了の日時・ゲームの版を集計サーバー（play-collector.hashimoshi15.workers.dev）へ送ります。本名・メールアドレス・電話番号・位置情報・広告ID・IPアドレスは保存しません。記録は集計にだけ使い、公開しません（ランキング・解析タグはありません）。保存期間は受信から 180 日で、過ぎた記録は自動で削除します。お問い合わせ: うな和の店頭スタッフ。チェックしなければ何も送りません。
Only for plays where the player ticks "Join the tally (optional)": for the per-shop tally the nickname (no real name needed), country / region, shop, the start and finish time and the game version are sent to the tally server (play-collector.hashimoshi15.workers.dev). No real name, email address, phone number, location, advertising ID or IP address is stored. Records are used only for totals and never published (no ranking, no analytics). They are kept for 180 days from receipt and then deleted automatically. Questions: the staff at Unawa (うな和). Without the tick nothing is sent.

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
