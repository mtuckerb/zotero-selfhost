# Zotero Selfhost

Zotero Selfhost is a full packaged repository aimed to make on-premise [Zotero](https://www.zotero.org) deployment easier with the last versions of both Zotero client and server. It started from the work of Samuel Hassine: https://github.com/SamuelHassine/zotero-prime.git. Major changes include:

* Reorganize directories 
    - All source codes are put into src, client code in src/client, server code in /src/server. Modifications to the original source is maintained as patches in ./pachtes.
    - Dockerfile & docker-composer.yml are put in top level because we want to be able to copy the necessary source into container instead of mapping host direct to container volumes. This avoid polluting source directories with node_modules and other compile results.
    - some runtime configurations & scripts used by docker images are put in config/, and mapping to docker volumes by docker-composer.
    - we use some utility scripts to help patch/update the official sources.

* necessary fixes 
    - mysql upgrade to 5.7 due to the need of large key size support. utf8mb4 needs large key size, zotero-prime choose to change it into utf8 but it might lead to issues.
    - add mysql server params (set sql_mode) to deal with syntax compatible issues. e.g. allow the use of zero dates.
    - adjust some default parameters of dataserver to avoid web-library rate/concurrency limit errors.
    - use ubuntu 18.04 as default app-zotero base image. Avoid dependence on third party PPA repositories(they are often slow or even unvailable for the author). Build stream-server & tinymce-clean-serve into image instead of building them at run time. Add missing actions to get rid of some warnings. Add useful packages like vim
    - ...

## the Zotero eco-system

It is not easy to fully understand the Zotero eco-system. It is composed of many components, and each component might be implemented with a different language or technology. Used languages include javascript/python/php/c/c++/shell/html, technologies like node.js, reactive, XULRunner, mysql/apache/redis/websocket/elasticsearch/memcached/localstack/aws/phpadmin, and etc. What's more, docs are far from enough. Up to now, I have not yet seen a clear overall arichitecture description. 

Here is my current understanding of Zotero:

### Architecture

Overall Zotero is a client/server system with some server components and some client components, both servers and clients rely on some other aiding components.

The core of server part is dataserver, which provides zotero API services. Dataserver is implemented in PHP, structure data is stored in mysql database, while documents and fulltext data are stored using amazon S3 storage or webdav. Dataserver uses localstack for SNS/SQS, memcached to cached data to reduce pressure of database server, elasticsearch to support searches, redis to do request rate limit(seems to handle notifications too), and optional StatsD for statistics(I guess). 

There are two types of clients. One is the zotero client downloadable from zotero.org. It is a native executable built upon XULRunner. This client is versatile. First, it provides interfaces for us to operate(import/export/edit/search/organize etc.) on our materials and stores local data in a SQLite database(by default in ~/Zotero/). Second, it is extensible. We can run javascript code in a console(Tools->Developer->Run JavaScript) or write a plugin to interact with the client UI and operate on local data. Third, it has a builtin HTTP server to import data from connectors(browser plugin that sense data from web pages). Fourth, it provides a word processor integration API. Fiveth, it contains a lots of translators that can help to extrace contents from web pages and export them to other formats. The other one is web-library that provides browser based interface. Note: for API server, web-library is a client using its services; but for users, web-library is a server that providing web base interface for them to use zotero.

### important concepts

* connector. Zoteror connectors are some browser plugins that provide the ability to sense data from web pages. they enable us to save web data into zotero(through zotero client or directly to online zotero database).
* translator. The zotero client contains many translators, they allow Zotero to extract information from webpages, import and export items in various file formats (e.g. BibTeX, RIS, etc.), and look up items when given identifiers (e.g. DOIs or PubMed IDs). 
* library. Just like the physical library, it is used to store informations like books, articles, documents and more.
* collection/subcollection. Items in Zotero libraries can be organized with collections and tags. Collections allow hierarchical organization of items into groups and subgroups. The same item can belong to multiple collections and subcollections in your library at the same item. Collections are useful for filing items in meaningful groups (e.g., items for a particular project, from a specific source, on a specific topic, or for a particular course). You can import items directly to a specific collection or add them to collections after they are already in your library.
* tags. Tags (often called “keywords” in other contexts) allow for detailed characterization of an item. You can tag items based on their topics, methods, status, ratings, or even based on your own workflow (e.g., “to-read”). Items can have as many tags as you like, and you can filter your library (or a specific collection) to show items having a specific set of one or more tags.  Tags are portable, but collections are not. Copying items between Zotero libraries (My Library and group libraries) will transfer their tags, but not their collection placements. Both organizational methods have unique advantages and features. Experiment with both to see what works best for your own workflow.

## Server installation

### Dependencies and source code

* make sure docker and docker-compose are installed in your build host.
* Clone the repository (with **--recursive** because there are multiple level of submodules)*:
```bash
$ mkdir /path/to/your/app && cd /path/to/your/app
$ git clone --recursive <reporitory url here>
$ cd zotero-selfhost
```
* To faciliate future updates, necessary changes to official code are maintained as patches in
src/patches/, run in top level directory, run ./utils/patch.sh to apply them.

```bash
./utils/patch.sh
```

*Configure and run*:
```bash
$ sudo docker-compose up -d
```
docker-compose will pull(mysql, minio, redis, localstack, elasticsearch, memcached, phpadmin) or build(app-zotero) all necessary docker images for you.

app-zotero is the main container for dataserver/stream-server/tinymce-clean-server.

### Initialize 

*Initialize databases, s3 buckets and SNS*:
```bash
$ ./bin/init.sh  //run after docker-compose up
$ cd ..
```

### NixOS module

This repository now exposes a NixOS module at `nixosModules.default` and `nixosModules.zotero-selfhost`.
It packages the upstream dataserver, stream-server, and tinymce-clean-server as systemd services.

Basic flake usage:

```nix
{
  inputs = {
    zotero-selfhost.url = "github:foxsen/zotero-selfhost";
  };

  outputs = { self, nixpkgs, zotero-selfhost, ... }: {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        zotero-selfhost.nixosModules.default
        ({ ... }: {
          system.stateVersion = "25.05";

          services.zotero-selfhost = {
            enable = true;
            sopsFile = /run/secrets/zotero-selfhost.yaml;
            baseUri = "https://zotero.example.com";
            attachmentProxyUrl = "https://files.example.com/";
            mysql.host = "127.0.0.1";
            redisHost = "127.0.0.1";
            memcachedHost = "127.0.0.1";
            elasticsearchHost = "127.0.0.1";
            s3.endpoint = "minio.internal:9000";
            s3.endpointUrl = "http://minio.internal:9000";
            s3.createBuckets = true;
          };
        })
      ];
    };
  };
}
```

Required SOPS keys under the default `secretPrefix = "zotero-selfhost"`:

- `zotero-selfhost/auth-salt`
- `zotero-selfhost/superuser-password`
- `zotero-selfhost/mysql-password`
- `zotero-selfhost/s3-access-key`
- `zotero-selfhost/s3-secret-key`
- `zotero-selfhost/attachment-proxy-secret`

The module creates these services:

- `zotero-selfhost`
- `zotero-selfhost-stream`
- `zotero-selfhost-tinymce`

It also installs helper commands into the system profile:

- `zotero-selfhost-init`
- `zotero-selfhost-create-user`

`zotero-selfhost-init` bootstraps the databases and optional S3 buckets.
`zotero-selfhost-create-user UID username password email` adds additional users.

Legacy plaintext secret options are still present only as hidden compatibility placeholders and now assert if used. Configure secrets via SOPS instead.

For a concrete deployment example, see:

- `docs/nixos-deployment.md`
- `examples/nixos/zotero-selfhost-host.nix`
- `examples/nixos/zotero-selfhost.sops.example.yaml`

### One-time manual setup

A few things can't be done by the NixOS module itself and need to be
run once after the first `nixos-rebuild switch`:

#### 1. Encrypt the SOPS secrets file

The `services.zotero-selfhost.sopsFile` path **must** point to a real
sops/age-encrypted file. If you put plaintext YAML there, sops-nix
activation fails with `failed to decrypt: sops metadata not found`
and the dataserver never starts. Encrypt with the same age recipient
your host uses:

```sh
sops --age age1<your-recipient> -e -i /data/zotero/zotero-selfhost.yaml
```

The required keys are listed in the SOPS keys table earlier in this
README.

#### 2. Create the `zotero` MariaDB user

NixOS's default MariaDB has `root` locked to `unix_socket` auth, so
the dataserver and `zotero-selfhost-init` (which both connect over
TCP) can't authenticate as root. Create a dedicated user with the
password from the sops file and grant it `ALL PRIVILEGES` (the init
script needs `CREATE`/`DROP DATABASE`):

```sh
MYSQL_PW=$(sops -d /data/zotero/zotero-selfhost.yaml | yq -r '."zotero-selfhost"."mysql-password"')
sudo mysql <<EOF
CREATE USER IF NOT EXISTS 'zotero'@'localhost' IDENTIFIED BY '$MYSQL_PW';
CREATE USER IF NOT EXISTS 'zotero'@'127.0.0.1' IDENTIFIED BY '$MYSQL_PW';
GRANT ALL PRIVILEGES ON *.* TO 'zotero'@'localhost' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON *.* TO 'zotero'@'127.0.0.1' WITH GRANT OPTION;
FLUSH PRIVILEGES;
EOF
```

Then set `services.zotero-selfhost.mysql.user = "zotero";` in your
flake config.

#### 3. Run the bootstrap

```sh
sudo zotero-selfhost-init
```

This:
- creates and seeds all five `zotero_*` databases
- adds a `validated` column to `zotero_www.users_email` (required by
  `Storage::getInstitutionalUserQuota` for file uploads)
- runs `admin/schema_update` to ingest the current `schema.json`
  mappings into the `fields`/`creatorTypes`/`itemTypes` tables (without
  this, write operations fail with "Field 'X' from schema N not found")
- creates the minio bucket(s) if `services.zotero-selfhost.s3.createBuckets`
  is true

It DROPs and recreates all five `zotero_*` dbs, so it's idempotent for
fresh installs but **destructive for live data** — never re-run against
a populated dataserver.

#### 4. (Optional) Restart minio if you encrypted the secrets after first boot

If your minio service started before the sops secrets file was
encrypted, the `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` environment
variables will be empty in the running process and minio will be
using its default `minioadmin` credentials instead of yours.
`sudo systemctl restart zotero-selfhost-minio` to fix.

#### 5. (Optional) Create an API key for the web library

Only needed if you're going to deploy the SPA at `/library/` (next
section). Generate a 24-char alphanumeric key and insert it into
`zotero_master.keys` for `userID = 1` (admin) with library-wide
permissions:

```sh
KEY=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
echo "Web library API key: $KEY"
sudo mysql -u zotero zotero_master <<EOF
INSERT INTO \`keys\` (keyID, \`key\`, userID, name)
  VALUES (1, '$KEY', 1, 'web-library admin');
INSERT INTO keyPermissions (keyID, libraryID, permission, granted) VALUES
  (1, 1, 'library', 1),
  (1, 1, 'notes', 1),
  (1, 1, 'write', 1);
EOF
sudo systemctl restart memcached
```

**Note:** `libraryID = 1` (admin's user library), **NOT** `libraryID = 0`
— the latter means "all groups", not "all libraries", and the dataserver
will return a misleading bare 403 with no error detail in logs.

### Remaining out-of-band hack: stream-server uws→ws

The upstream `zotero/stream-server` repo depends on `uws`
(µWebSockets) `10.148.1`, an abandoned native module with no prebuilt
binaries for modern Node and source that no longer compiles against
modern Node ABIs. The NixOS module's `streamServerNodeDeps` FOD will
fail (or silently fall back to a non-working stub) on any reasonably
modern host.

**Workaround:** maintain a hand-patched copy of the stream-server
source at a stable path (e.g. `/var/lib/zotero-stream-server-overlay/`)
with `uws` replaced by `ws ^7.5.10`. The required source patches are
small:

```diff
--- a/connections.js
+++ b/connections.js
@@ -27,1 +27,1 @@
-var WebSocket = require('uws');
+var WebSocket = require('ws');

--- a/server.js
+++ b/server.js
@@ -635,1 +635,1 @@
-		var WebSocketServer = require('uws').Server;
+		var WebSocketServer = require('ws').Server;
@@ -649,3 +650,7 @@
-		wss.on('connection', function (ws) {
+		// `ws` v3+ removed `upgradeReq`; stash req from the second arg
+		wss.on('connection', function (ws, req) {
+			ws.upgradeReq = req;
 			var remoteAddress = ws._socket.remoteAddress;
 			var xForwardedFor = ws.upgradeReq.headers['x-forwarded-for'];

--- a/package.json
+++ b/package.json
@@
-    "uws": "10.148.1"
+    "ws": "^7.5.10"
```

After patching, `npm install --omit=dev` to populate `node_modules`,
then drop the whole tree at `/var/lib/zotero-stream-server-overlay/`
(owned by `zotero:zotero`) and override the systemd unit's
`ExecStartPre` to rsync the overlay over the runtime dir on each
start:

```nix
systemd.services.zotero-selfhost-stream.serviceConfig.ExecStartPre =
  lib.mkForce (pkgs.writeShellScript "zotero-stream-overlay-prepare" ''
    set -euo pipefail
    ${pkgs.coreutils}/bin/mkdir -p /var/lib/zotero-selfhost/runtime/stream-server
    ${pkgs.rsync}/bin/rsync -a --delete \
      /var/lib/zotero-stream-server-overlay/ \
      /var/lib/zotero-selfhost/runtime/stream-server/
  '');
```

The proper long-term fix is to either patch the upstream
`zotero/stream-server` source and replace `streamServerSrc`, or open
a PR upstream. The stream server is only used for realtime
notifications; the dataserver, web library, and Zotero clients all
work fine without it (clients fall back to polling).

### Adding the web library frontend

The upstream NixOS module deploys only the dataserver, stream-server,
tinymce-clean-server, and minio. To get a browsable web UI for human
users, build and deploy `zotero/web-library` separately.

```sh
git clone --recursive https://github.com/zotero/web-library.git ~/zotero-web-library-local
cd ~/zotero-web-library-local
```

#### Build script patches needed for nix hosts

Two patches are required to build on a NixOS host:

1. **`scripts/task-runner.mjs`** — wrap `process.stdin.setRawMode(true|false)`
   in `if (process.stdin.isTTY)` checks. Without this, `npm run build`
   throws `process.stdin.setRawMode is not a function` because the build
   script tries to set raw mode for its interactive task picker, which
   fails when stdin isn't a TTY (e.g. running from a non-interactive
   shell or via `nixos-rebuild`).

2. **`scripts/build.mjs`** — change all `cp -aL` to `cp -arL`. The
   system `cp` on NixOS may be `uutils-coreutils` (Rust rewrite) which
   does **not** treat `-a` as `-rL` like GNU `cp` does. Without this,
   the `Static` build task fails with `cp: -r not specified; omitting
   directory 'src/static/reader'`.

#### Source patches for self-hosting

```diff
--- a/src/js/constants/defaults.js
+++ b/src/js/constants/defaults.js
@@ apiConfig
-  apiAuthorityPart: 'api.zotero.org',
+  apiAuthorityPart: 'zotero.example.com',
@@ websiteUrl
-export const websiteUrl = 'https://www.zotero.org/';
+export const websiteUrl = 'https://zotero.example.com/';
@@ streamingApiUrl
-export const streamingApiUrl = 'wss://stream.zotero.org/';
+export const streamingApiUrl = 'wss://zotero.example.com/stream/';

--- a/src/js/utils.js
+++ b/src/js/utils.js
@@ getItemCanonicalUrl
-  `http://zotero.org/${libraryKey.startsWith('u') ? 'users' : 'groups'}/${libraryKey.slice(1)}/items/${itemKey}`;
+  `https://zotero.example.com/${libraryKey.startsWith('u') ? 'users' : 'groups'}/${libraryKey.slice(1)}/items/${itemKey}`;
@@ getItemFromCanonicalUrl
-  const match = url.match('https?://zotero.org/(users|groups)/([0-9]+)/items/([A-Z0-9]{8})');
+  const match = url.match('https?://(?:zotero\\.org|zotero\\.example\\.com)/(users|groups)/([0-9]+)/items/([A-Z0-9]{8})');

--- a/src/html/index.html
+++ b/src/html/index.html
@@ zotero-web-library-config
-  { "userSlug": "zotero-user", "userId": "475425", "libraries": { ... } }
+  { "userSlug": "admin", "userId": "1", "apiKey": "<KEY-FROM-STEP-7>" }
```

(The parser regex accepts both `zotero.org` and your hostname so existing
items synced from upstream Zotero still parse correctly.)

You can also strip the upstream's hardcoded demo menu config
(`zotero-web-library-menu-config`) down to a single `My Library →
/library/` entry — most of the upstream menu links point at zotero.org
www-site pages (`/mylibrary`, `/groups`, `/support`, `/getinvolved`,
`/testuser1`, `/settings`, `/user/logout`, etc) that don't exist on a
self-host.

#### Build and deploy

```sh
nix-shell -p nodejs_20 --run 'npm install --legacy-peer-deps --no-audit --no-fund'
nix-shell -p nodejs_20 --run 'npm run build'

# Layout: URL prefix matches FS path so try_files works cleanly with
# `root` instead of `alias` (which has annoying edge cases with try_files)
sudo mkdir -p /var/lib/zotero-web-library-root/library
sudo cp -r build/* /var/lib/zotero-web-library-root/library/
sudo chown -R nginx:nginx /var/lib/zotero-web-library-root
```

`--legacy-peer-deps` is needed because some optional dev deps want
Node ≥22 while we build with 20.

#### Set up basic auth for /library/

The bundled API key in `zotero-web-library.js` is visible to anyone who
can fetch the JS bundle, so gate the SPA paths with HTTP basic auth.
The dataserver API stays open so Zotero desktop / mobile clients can
still sync via their own `Zotero-API-Key` headers (those clients don't
speak basic auth and would break if we gated the API).

```sh
nix-shell -p apacheHttpd --run \
  'sudo htpasswd -B -c /etc/nginx/htpasswd.zotero-library admin'
sudo chown nginx:nginx /etc/nginx/htpasswd.zotero-library
sudo chmod 644 /etc/nginx/htpasswd.zotero-library
```

The `basicAuthFile` directives in the nginx override (override #5 above)
already point at this path. Rebuild with `nixos-rebuild switch` and the
SPA will require `admin` + the password you set.

### Verification

If everything is wired up, these should work:

```sh
KEY="<your-api-key-from-step-7>"
PW="<your-basic-auth-password>"

# API endpoints (no basic auth — Zotero clients use these)
curl -sk -o /dev/null -w "itemTypes: %{http_code}\n" \
  https://zotero.example.com/itemTypes
curl -sk -o /dev/null -w "items: %{http_code}\n" \
  -H "Zotero-API-Key: $KEY" https://zotero.example.com/users/1/items

# Web library SPA (basic auth required)
curl -sk -o /dev/null -w "library no auth: %{http_code}\n" \
  https://zotero.example.com/library/    # → 401
curl -sk -o /dev/null -w "library with auth: %{http_code}\n" \
  -u "admin:$PW" https://zotero.example.com/library/    # → 200
```

For an end-to-end smoke test, POST a sample item via the API and
confirm it shows up in the SPA after re-fetching:

```sh
curl -sk -X POST -H "Zotero-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '[{"itemType":"book","title":"Test","creators":[{"creatorType":"author","name":"Test"}],"date":"2026"}]' \
  https://zotero.example.com/users/1/items
```

The response should include `"success": { "0": "<8-char-key>" }`.

### Known limitations

- **The web library is single-user.** The `apiKey` is baked into the JS
  bundle at build time. Multi-user web access would require either
  multiple builds at different `/library/<user>/` paths (gated by
  separate htpasswd entries) or a runtime config-injection patch to
  `src/html/index.html` that loads the apiKey from a cookie or query
  parameter.
- **API access is fully multi-user.** Create additional users in
  `zotero_master.users` + `libraries` + `shardLibraries`, generate API
  keys for each, and any number of Zotero desktop / mobile clients can
  authenticate independently. (The shipped `zotero-selfhost-create-user`
  binary has the same column-count bugs as the init script and needs
  the same fixes.)
- **The web library still fetches CSL styles from `https://www.zotero.org/styles/`**
  for citation formatting. To fully self-host, mirror the styles repo
  and update the `stylesSourceUrl` and `stylesBaseUrl` constants in
  `defaults.js` before building.
- **The closure caveat.** Override #4 uses `lib.mkForce` to replace
  `ExecStartPre`, which removes the upstream prepare from the system
  closure. Nix won't rebuild it on subsequent `nixos-rebuild` runs;
  the glob still finds it because GC hasn't pruned it, but if you
  ever run `nix-collect-garbage --delete-old`, the upstream prepare
  disappears and the override can't find it. Long-term fix: build a
  complete prepare script in the override rather than globbing.
- **Pre-existing failing services on the example host** (e.g.
  `cliproxyapi-dashboard`, `ollama-model-loader`) are unrelated to
  zotero — ignore when triaging.

*Available endpoints*:

| Name          | URL                                           |
| ------------- | --------------------------------------------- |
| Zotero API    | http://localhost:8080                         |
| Stream ws     | ws://localhost:8081                           |
| S3 Web UI     | http://localhost:8082                         |
| PHPMyAdmin    | http://localhost:8083                         |

*Default login/password*:

| Name          | Login                    | Password           |
| ------------- | ------------------------ | ------------------ |
| Zotero API    | admin                    | admin              |
| S3 Web UI     | zotero                   | zoterodocker       |
| PHPMyAdmin    | root                     | zotero             |

## Client installation

The official client source is almost usable. Only a few patches are needed
to change hard-coded *zotero.org* into your urls.  Patches are put in 
./src/patches/zotero-client/. 


In fact, you can direct download the clients from zotero website, and change
the file in zoter.jar:

```bash
$ unpack Zoter Client, cd into the directory
$ mkdir tmp && cd ./tmp
$ jar xvf ../zotero.jar
$ ... edit the ./resource/config.js file here
$ rm -f ../zotero.jar && jar cvf ../zotero.jar .
```

If you are running with both server and client in your machine, only change
./resource/config.js is enough. Otherwise, you need to change this file too:
chrome/content/zotero/xpcom/storage/zfs.js. Because the dataserver is modified 
to return S3 url of http://localhost:8080, client will try to use that to access
the S3 storage and fail with S3 return 0 errors. The following patch shows how to
change, but remember to change the domain name to your real one.

```
diff --git a/chrome/content/zotero/xpcom/storage/zfs.js b/chrome/content/zotero/xpcom/storage/zfs.js
index 794b5cbad..ff27a001d 100644
--- a/chrome/content/zotero/xpcom/storage/zfs.js
+++ b/chrome/content/zotero/xpcom/storage/zfs.js
@@ -636,6 +636,10 @@ Zotero.Sync.Storage.Mode.ZFS.prototype = {
 		}
 		
 		var blob = new Blob([params.prefix, file, params.suffix]);
+
+		// FIXME: change https://zotero.your.domain to your server link
+		var url = params.url.replace(/http:\/\/localhost:8082/, 'https://zotero.your.domain');
+		params.url = url;
 		
 		try {
 			var req = yield Zotero.HTTP.request(

```

The build process is the same as official one.

### Dependencies and source code

*Install dependencies for client build*:
```bash
$ sudo apt install npm
```

For [m|l|w]: m=Mac, w=Windows, l=Linux

*Run*:
```bash
$ cd client
$ ./config.sh
$ cd zotero-client
$ npm install
$ npm run build
$ cd ../zotero-standalone-build
$ ./fetch_xulrunner.sh -p [m|l|w]
$ ./fetch_pdftools
$ ./scripts/dir_build -p [m|l|w]
```

### First usage

*Run*:
```bash
$ ./staging/Zotero_VERSION/zotero(.exe)
```

*Connect with the default user and password*:

| Name          | Login                    | Password           |
| ------------- | ------------------------ | ------------------ |
| Zotero        | admin                    | admin              |

## deployment

For personal usage, you can run the server and client in the same machine and
it should be working. The source code is modified for that.

For intranet usage, change the client side's url, replace localhost with server
IP.

For internet usage, you can setup a website with ssl enabled, and use reverse 
proxy to get it back to internal servers. Of course, you can enable SSL and deploy
it directly in external servers, but I have not tried that.

## server management

There are no user management interface for now. You can use the script
./bin/create-user.sh to add some users.

## TODO

* **Fix the upstream NixOS module bugs at the source.** The "NixOS gotchas"
  section above documents 5 workarounds that all live downstream of
  `nix/module.nix`. The right long-term home for them is the module
  itself: add `include_path` and `auto_prepend_file` to the `php` build,
  fetch zotero-schema as a submodule (or as a separate `pkgs.fetchFromGitHub`),
  extract `Zend.tar.gz` in `dataserverPkg`'s installPhase, pin `nodejs_20`
  for the npm-based services, fix the init script's column counts, drop
  the removed `innodb_large_prefix` SET, and either replace `uws` in
  `streamServerSrc` or upstream a fix to `zotero/stream-server`.
* **Package the web library as a NixOS module option.** Right now the SPA
  is built and deployed manually; ideally this would be
  `services.zotero-selfhost.webLibrary.enable = true;` with options for
  the API key, hostname, and basic auth file.
* **A real login/register flow** instead of basic auth + a baked-in API
  key. The current single-user setup is fine for personal hosts but
  doesn't scale.
* **Fix `zotero-selfhost-create-user`** — same column-count bugs as the
  init script.
