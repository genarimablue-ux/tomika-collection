# Futaのトミカコレクション — ソース一式の使い方

このZIPには、フロントエンド、Node.js API、公式トミカ商品データ（No.1〜150）、公式データ取得スクリプト、画面画像、ビルド／Docker設定を含みます。`.git`、`node_modules`、生成物の`dist/`、認証情報や`.env`は含めていません。

## 必要な環境

- Node.js **22.23.4**（`package.json`の指定バージョン）とnpm
- TLS接続可能なMySQL互換データベース
- `MANUS_API_URL` / `MANUS_API_KEY` でアクセスできるManus Storage互換API（その他の保存サービスを使う場合は、`server.js`のストレージ連携を置き換えてください）

アプリサーバーは起動時に`DATABASE_URL`が必要です。データベースのテーブルは初回起動時に自動作成されます。車両写真の登録にはストレージ用API設定も必要です。すべての秘密情報はサーバー環境だけに設定し、ブラウザーコードやGitHubへ入れないでください。

## ローカル起動（macOS / Linux）

ZIPを展開し、展開先フォルダーで実行します。

```bash
npm ci
export DATABASE_URL='mysql://USER:URLエンコード済みPASSWORD@DB_HOST:3306/DATABASE_NAME'
export MANUS_API_URL='ストレージAPIのベースURL'
export MANUS_API_KEY='ストレージAPIキー'
npm run dev
```

ブラウザーで <http://localhost:3000> を開きます。`npm run dev`は`dist/`を作り直してからAPIとサイトを起動します。停止はターミナルで`Ctrl+C`です。

## Windows PowerShell

```powershell
npm ci
$env:DATABASE_URL = 'mysql://USER:URLエンコード済みPASSWORD@DB_HOST:3306/DATABASE_NAME'
$env:MANUS_API_URL = 'ストレージAPIのベースURL'
$env:MANUS_API_KEY = 'ストレージAPIキー'
npm run dev
```

`DATABASE_URL`のユーザー名・パスワードに`@`、`/`、`:`などが含まれる場合はURLエンコードしてください。各サービスから受け取った実際の接続値を使い、例示文字列をそのまま入力しないでください。

環境変数を毎回手入力せずDockerを使う場合は、ローカルの`.env`（このファイルはGit管理対象外にしてください）に同じ3項目を設定し、`docker build -t tomica-collection .`と`docker run --rm --env-file .env -p 3000:3000 tomica-collection`を実行します。

## GitHubで管理・公開する場合

GitHubへはこのZIPを展開したソース一式をリポジトリとして登録できます。`README.md`に従って`git init`、`git add`、`git commit`、GitHubリモートへの`git push`を行ってください。Node.jsのロックファイル、データJSON、写真素材も一緒に含まれています。

**GitHub Pagesだけではアプリ全体は動きません。** Pagesは静的ファイルのみを配信するため、同期API・MySQL保存・写真アップロードは提供されません。完全な機能を公開するには、Dockerfileに対応するNode.jsコンテナを実行できるホスティング、外部MySQL、Manus Storage互換APIが必要です。デプロイ先の環境変数／シークレットに`DATABASE_URL`、`MANUS_API_URL`、`MANUS_API_KEY`を設定し、`PORT`（既定値3000）をコンテナへ渡してください。

公開URLを知る人はログインなしで共有データを閲覧・編集できる仕様です。公開範囲に注意してください。

## データと主なファイル

- `data/tomica-catalog.json` — 公式レギュラーNo.1〜150の番号・名称・画像URL（データ一式）
- `data/catalog.js` — JSONを画面へ読み込むモジュール
- `scripts/fetch_official_catalog.py` — タカラトミー公式ページから商品リストを再取得する標準Pythonライブラリのみのスクリプト
- `index.html` / `styles.css` / `app.js` — 画面構造、見た目、ブラウザー側の機能
- `server.js` — API、MySQLスキーマ、自動同期、画像アップロード
- `images/` — ユーザー提供の元写真、Web向け最適化写真、アプリマーク、代替画像
- `package.json` / `package-lock.json` / `build.sh` / `Dockerfile` — 依存関係、ビルド、サーバー起動設定
- `README.md` / `TODO.md` / `plan.md` — 操作・仕様・開発情報

公式商品データを更新するときは、Python 3が入った環境で次を実行します。

```bash
python3 scripts/fetch_official_catalog.py
```

取得元: [タカラトミー公式 トミカシリーズ商品ラインナップ](https://www.takaratomy.co.jp/products/tomica/lineup/regular/)
