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

### NixOS gotchas — workarounds you must apply

The NixOS module above has several latent issues that only surface once the
service actually tries to handle a request. The bugs were originally hidden
behind a sops-decryption failure that prevented the dataserver from starting
at all; once that's fixed, you'll hit them in roughly this order. Below is
a single drop-in override block you can paste into the same NixOS module
where you set `services.zotero-selfhost.enable = true;`. Each block is
explained in the comments. Tested on NixOS unstable + nixpkgs `nixos-25.05`
+ MariaDB 11.4 + Node 24 (default `pkgs.nodejs`) as of 2026-04-08.

You will also need a few one-time manual steps for things the module
doesn't bootstrap (Zend Framework 1, the dataserver schema mapping tables,
the MySQL user, the API key for the web library). Those are documented
under "Manual setup steps" further below.

```nix
{ config, lib, pkgs, ... }:

{
  services.zotero-selfhost = {
    enable = true;
    sopsFile = "/data/zotero/zotero-selfhost.yaml";
    # If port 8080 is taken on your host (e.g. by another service), set
    # something else. nginx and the dataserver both follow this option.
    listenPort = 8085;
    # MariaDB on most NixOS hosts has root locked to unix_socket auth, so
    # the dataserver and init script can't authenticate as root over TCP.
    # Use a dedicated `zotero` user (created out of band — see below).
    mysql.user = "zotero";
    infrastructure = {
      enable = true;
      hostname = "zotero.example.com";
      attachmentsHostname = "attachments.zotero.example.com";
      enableACME = true;
      forceSSL = true;
      minioPort = 9002;
      minioConsolePort = 9003;
    };
  };

  # ── 1. Runtime Node 20 for tinymce-clean-server ─────────────────────
  # The bundled `node-config` npm package calls `util.isRegExp` which was
  # removed in Node 22+. The upstream module uses `pkgs.nodejs` (currently
  # 24). Pure-JS deps are portable across node versions, so a runtime-only
  # swap suffices for tinymce. Do NOT override `pkgs.nodejs` at build time
  # — that invalidates `dataserverPkg` which then needs network to run
  # `composer install` and fails in the nix sandbox.
  systemd.services.zotero-selfhost-tinymce.serviceConfig.ExecStart =
    lib.mkForce "${pkgs.nodejs_20}/bin/node /var/lib/zotero-selfhost/runtime/tinymce-clean-server/server.js";

  # ── 2. Stream-server: replace `uws` with `ws` ──────────────────────
  # The upstream `zotero/stream-server` depends on `uws` (µWebSockets), an
  # abandoned native module with no prebuilt binaries for modern Node and
  # source that no longer compiles. We maintain a hand-patched copy at
  # /var/lib/zotero-stream-server-overlay/ (see "Manual setup steps" for
  # how to build it). ExecStartPre rsyncs the overlay over the runtime
  # dir on every start so the upstream prepare's broken `npm ci` for uws
  # is never observed.
  systemd.services.zotero-selfhost-stream.serviceConfig.ExecStartPre =
    lib.mkForce (pkgs.writeShellScript "zotero-stream-overlay-prepare" ''
      set -euo pipefail
      ${pkgs.coreutils}/bin/mkdir -p /var/lib/zotero-selfhost/runtime/stream-server
      ${pkgs.rsync}/bin/rsync -a --delete \
        /var/lib/zotero-stream-server-overlay/ \
        /var/lib/zotero-selfhost/runtime/stream-server/
    '');
  systemd.services.zotero-selfhost-stream.serviceConfig.ExecStart =
    lib.mkForce "${pkgs.nodejs_20}/bin/node /var/lib/zotero-selfhost/runtime/stream-server/index.js";

  # ── 3. Dataserver php: include_path + auto_prepend_file ─────────────
  # The upstream `php` build is missing two settings the dataserver
  # depends on, and the upstream `php -S` ExecStart doesn't pass them:
  #   - include_path: htdocs/index.php does `require('config/routes.inc.php')`
  #     and PHP can't find include/config/routes.inc.php without it.
  #   - auto_prepend_file: htdocs/index.php uses Z_ENV_CONTROLLER_PATH and
  #     other constants defined in include/header.inc.php but never
  #     explicitly includes header.inc.php. The upstream Apache config
  #     auto-prepends it; `php -S` doesn't unless the ini says so.
  # Both must be set or PHP returns silent HTTP 500 (display_errors=Off,
  # stderr swallowed by `php -S`). Override ExecStart with a buildEnv
  # that adds both.
  systemd.services.zotero-selfhost.serviceConfig.ExecStart =
    let
      zoteroPhp = pkgs.php84.buildEnv {
        extensions = ({ enabled, all }: enabled ++ (with all; [ curl intl mbstring mysqli redis memcached ]));
        extraConfig = ''
          memory_limit = 1G
          max_execution_time = 300
          short_open_tag = On
          display_errors = Off
          error_reporting = E_ALL & ~E_NOTICE & ~E_STRICT & ~E_DEPRECATED
          include_path = ".:/var/lib/zotero-selfhost/runtime/dataserver/htdocs:/var/lib/zotero-selfhost/runtime/dataserver/include"
          auto_prepend_file = "/var/lib/zotero-selfhost/runtime/dataserver/include/header.inc.php"
        '';
      };
    in
    lib.mkForce "${zoteroPhp}/bin/php -S 127.0.0.1:${toString config.services.zotero-selfhost.listenPort} -t /var/lib/zotero-selfhost/runtime/dataserver/htdocs /var/lib/zotero-selfhost/runtime/dataserver/htdocs/index.php";

  # ── 4. Dataserver prepare: Zend + zotero-schema overlay + dbconnect sed ─
  # Three things the upstream prepare misses:
  # (a) Zend Framework 1 — `htdocs/Zend/` is empty (the ZF1 archive in
  #     src/patches/dataserver/Zend.tar.gz is extracted by docker
  #     utils/patch.sh but the nix dataserverPkg installPhase skips it).
  #     Stash Zend.tar.gz at /var/lib/zotero-dataserver-extras/ (see
  #     "Manual setup steps") and we tar -x it on every start.
  # (b) zotero-schema — htdocs/zotero-schema/ is a git submodule of the
  #     dataserver source, but pkgs.fetchFromGitHub doesn't fetch
  #     submodules. Without schema.json the dataserver throws "Locales
  #     not available" → silent HTTP 500 on /itemTypes etc.
  # (c) dbconnect.inc.php uses 'root' as the mysql user even when
  #     services.zotero-selfhost.mysql.user is set — because our mkForce
  #     of ExecStartPre below removes the upstream prepare from the
  #     system closure, so its writeDataserverConfig dependency doesn't
  #     get rebuilt either. We sed-patch the rendered file as a workaround.
  # MUST use `tar --use-compress-program=gzip` — bare `tar -xzf` fails
  # because the systemd unit's PATH has no `gzip` and gnutar tries to
  # exec it.
  systemd.services.zotero-selfhost.serviceConfig.ExecStartPre =
    lib.mkForce (pkgs.writeShellScript "zotero-dataserver-prepare-with-extras" ''
      set -euo pipefail
      # Glob for the upstream prepare script. There should normally be
      # exactly one matching path; pick the most recently built if
      # multiple exist.
      upstream_prepare=$(${pkgs.coreutils}/bin/ls -1dt /nix/store/*-zotero-dataserver-prepare 2>/dev/null | ${pkgs.coreutils}/bin/head -n1)
      if [ -z "$upstream_prepare" ]; then
        echo "FATAL: no zotero-dataserver-prepare in /nix/store" >&2
        exit 1
      fi
      "$upstream_prepare"

      # Overlay Zend Framework 1
      ${pkgs.gnutar}/bin/tar \
        --use-compress-program=${pkgs.gzip}/bin/gzip \
        -xf /var/lib/zotero-dataserver-extras/Zend.tar.gz \
        -C /var/lib/zotero-selfhost/runtime/dataserver/include/

      # Overlay zotero-schema/schema.json
      ${pkgs.coreutils}/bin/mkdir -p \
        /var/lib/zotero-selfhost/runtime/dataserver/htdocs/zotero-schema
      ${pkgs.coreutils}/bin/cp \
        /var/lib/zotero-dataserver-extras/zotero-schema/schema.json \
        /var/lib/zotero-selfhost/runtime/dataserver/htdocs/zotero-schema/schema.json

      # Patch dbconnect.inc.php to use the `zotero` mysql user
      ${pkgs.gnused}/bin/sed -i \
        "s/\\\$user = 'root';/\$user = 'zotero';/g" \
        /var/lib/zotero-selfhost/runtime/dataserver/include/config/dbconnect.inc.php
    '');

  # ── 5. (Optional) Web library SPA at /library/ + basic auth ─────────
  # The upstream module deploys ONLY the dataserver, stream-server, and
  # tinymce-clean-server — there's no browsable web UI. We add the
  # zotero/web-library SPA out of band; see "Adding the web library
  # frontend" below for the build steps. The two locations below assume
  # you've put the build at /var/lib/zotero-web-library-root/library/
  # and an htpasswd file at /etc/nginx/htpasswd.zotero-library.
  services.nginx.virtualHosts."zotero.example.com".locations = {
    "/library/" = {
      root = "/var/lib/zotero-web-library-root";
      tryFiles = "$uri $uri/ /library/index.html =404";
      basicAuthFile = "/etc/nginx/htpasswd.zotero-library";
    };
    "/static/web-library/" = {
      alias = "/var/lib/zotero-web-library-root/library/static/web-library/";
      basicAuthFile = "/etc/nginx/htpasswd.zotero-library";
    };
    # Redirect bare https://zotero.example.com/ → /library/
    # `= /` is nginx's exact-match modifier so this only fires for GET /
    # and not /users/..., /itemTypes, /library/..., etc.
    "= /" = {
      return = "302 /library/";
    };
  };
}
```

### Manual setup steps

These can't be expressed cleanly as nix module options (yet). Run them
once, after `nixos-rebuild switch` brings the services up for the first
time.

#### 1. Pre-create runtime working directories

The upstream module's `WorkingDirectory=/var/lib/zotero-selfhost/runtime/{dataserver/htdocs,tinymce-clean-server,stream-server}`
is checked by systemd **before** `ExecStartPre` runs, so the first start
after a clean state hits a chicken-and-egg failure. Create them once:

```sh
sudo mkdir -p /var/lib/zotero-selfhost/runtime/dataserver/htdocs \
              /var/lib/zotero-selfhost/runtime/tinymce-clean-server \
              /var/lib/zotero-selfhost/runtime/stream-server
sudo chown -R zotero:zotero /var/lib/zotero-selfhost/runtime
```

#### 2. Encrypt the sops secrets file

The `services.zotero-selfhost.sopsFile` path **must** point to a real
sops/age-encrypted file. If you put plaintext YAML there, sops-nix
activation fails with `failed to decrypt: sops metadata not found` and
the dataserver never starts. Encrypt with the same age recipient your
host uses:

```sh
sops --age age1<your-recipient> -e -i /data/zotero/zotero-selfhost.yaml
```

The required keys are listed in the SOPS keys table earlier in this
README.

#### 3. Create the `zotero` MySQL user

The init script and dataserver both connect to MariaDB over TCP, but
NixOS's default MariaDB has `root` locked to `unix_socket` auth, so TCP
password auth fails with "Access denied". Use a dedicated user with the
password from your sops file:

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

(`GRANT ALL ON *.*` is needed because the init script runs `CREATE`/`DROP DATABASE`.)

#### 4. Stash Zend.tar.gz and zotero-schema/schema.json

The dataserver's prepare overlay (override #4 above) reads two files
from `/var/lib/zotero-dataserver-extras/`. Both come from upstream but
aren't deployed by the nix module:

```sh
sudo mkdir -p /var/lib/zotero-dataserver-extras/zotero-schema

# Zend Framework 1 — bundled in this repo
sudo cp src/patches/dataserver/Zend.tar.gz /var/lib/zotero-dataserver-extras/

# zotero-schema/schema.json — clone from upstream
git clone https://github.com/zotero/zotero-schema.git /tmp/zotero-schema
sudo cp /tmp/zotero-schema/schema.json /var/lib/zotero-dataserver-extras/zotero-schema/
```

#### 5. Bootstrap the databases

The shipped `zotero-selfhost-init` (the binary the NixOS module installs)
**does not work as-shipped** against MariaDB 11.4 + the current
`zotero/dataserver` schema. Failures, in order:

1. `SET @@global.innodb_large_prefix = 1` — variable was removed in
   MariaDB 10.5+. Skip; DYNAMIC row format is the default now.
2. `INSERT INTO libraries VALUES (1, 'user', CURRENT_TIMESTAMP, 0, 1)` —
   schema has 6 cols (libraryID, libraryType, lastUpdated, version,
   shardID, **hasData**), upstream insert provides 5.
3. `INSERT INTO users VALUES (1, 1, '$user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
   in zotero_master — schema has 3 cols (userID, libraryID, username),
   upstream provides 5.
4. `INSERT INTO shardLibraries VALUES (1, 'user', CURRENT_TIMESTAMP, 0)` —
   schema has 5 cols (libraryID, libraryType, lastUpdated, version,
   **storageUsage**), upstream provides 4.

Fixed init script (drop into `/var/lib/zotero-dataserver-extras/`):

```bash
#!/usr/bin/env bash
set -euo pipefail
read_secret() { tr -d '\n' < "$1"; }
sql_escape() { printf '%s' "$1" | perl -pe 's/\x27/\x27\x27/g'; }
MYSQL_PWD="$(read_secret /run/secrets/zotero-selfhost/mysql-password)"
export MYSQL_PWD
misc=$(ls -1d /nix/store/*-zotero-selfhost-dataserver-git/share/zotero-dataserver/misc | head -n1)
www_sql=$(ls -1 /nix/store/*-www.sql | head -n1)
superuser_password_sql="$(sql_escape "$(read_secret /run/secrets/zotero-selfhost/superuser-password)")"
superuser_name_sql="$(sql_escape admin)"

mysql_base() {
  /run/current-system/sw/bin/mariadb -h 127.0.0.1 -P 3306 -u zotero "$@"
}

# innodb_large_prefix removed in MariaDB 10.5+
echo 'set global sql_mode = "";' | mysql_base

for db in zotero_master zotero_shard_1 zotero_shard_2 zotero_ids zotero_www; do
  echo "DROP DATABASE IF EXISTS $db" | mysql_base
  echo "CREATE DATABASE $db" | mysql_base
done

mysql_base zotero_master < "$misc/master.sql"
mysql_base zotero_master < "$misc/coredata.sql"
echo "INSERT INTO shardHosts VALUES (1, '127.0.0.1', 3306, 'up');" | mysql_base zotero_master
echo "INSERT INTO shards VALUES (1, 1, 'zotero_shard_1', 'up', '1');" | mysql_base zotero_master
echo "INSERT INTO shards VALUES (2, 1, 'zotero_shard_2', 'up', '1');" | mysql_base zotero_master
echo "INSERT INTO libraries (libraryID, libraryType, lastUpdated, version, shardID, hasData) VALUES (1, 'user', CURRENT_TIMESTAMP, 0, 1, 0)" | mysql_base zotero_master
echo "INSERT INTO libraries (libraryID, libraryType, lastUpdated, version, shardID, hasData) VALUES (2, 'group', CURRENT_TIMESTAMP, 0, 2, 0)" | mysql_base zotero_master
echo "INSERT INTO users (userID, libraryID, username) VALUES (1, 1, '$superuser_name_sql')" | mysql_base zotero_master
echo "INSERT INTO groups VALUES (1, 2, 'Shared', 'shared', 'Private', 'members', 'all', 'members', \"\", \"\", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)" | mysql_base zotero_master
echo "INSERT INTO groupUsers VALUES (1, 1, 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)" | mysql_base zotero_master

mysql_base zotero_www < "$www_sql"
echo "INSERT INTO users VALUES (1, '$superuser_name_sql', MD5('$superuser_password_sql'), 'normal')" | mysql_base zotero_www
echo "INSERT INTO users_email (userID, email) VALUES (1, 'admin@zotero.org')" | mysql_base zotero_www
echo "INSERT INTO storage_institutions (institutionID, domain, storageQuota) VALUES (1, 'zotero.org', 10000)" | mysql_base zotero_www
echo "INSERT INTO storage_institution_email (institutionID, email) VALUES (1, 'contact@zotero.org')" | mysql_base zotero_www

for shard in zotero_shard_1 zotero_shard_2; do
  mysql_base "$shard" < "$misc/shard.sql"
  mysql_base "$shard" < "$misc/triggers.sql"
done
echo "INSERT INTO shardLibraries (libraryID, libraryType, lastUpdated, version, storageUsage) VALUES (1, 'user', CURRENT_TIMESTAMP, 0, 0)" | mysql_base zotero_shard_1
echo "INSERT INTO shardLibraries (libraryID, libraryType, lastUpdated, version, storageUsage) VALUES (2, 'group', CURRENT_TIMESTAMP, 0, 0)" | mysql_base zotero_shard_2
mysql_base zotero_ids < "$misc/ids.sql"

echo "DB init OK"
```

Run it once:

```sh
sudo bash /var/lib/zotero-dataserver-extras/zotero-init-fixed.sh
```

It DROPs and recreates all five `zotero_*` dbs, so it's idempotent for
fresh installs but **destructive for live data** — never run against a
populated dataserver.

#### 6. Ingest the schema into the DB tables

After step 5 the `fields`, `creatorTypes`, `itemTypes`, `itemTypeFields`,
`baseFieldMappings`, and `itemTypeCreatorTypes` tables are pinned to
whatever `coredata.sql` shipped (typically schema ~32). Recent schema
versions add fields like `eventPlace`, `citationKey`, `dataset` itemType,
etc. Without ingesting them, write operations fail with `Field 'X' from
schema N not found in ItemFields.inc.php:222`.

The dataserver has an `admin/schema_update` PHP script that ingests
schema.json. Three gotchas:

1. **It collides with our `auto_prepend_file` override** — pass
   `-d auto_prepend_file=` to disable for this invocation only,
   otherwise `header.inc.php` gets included twice and you get a fatal
   `Cannot redeclare zotero_autoload`.
2. **It short-circuits if `settings.schemaVersion >= file version`**.
   On first run there's no row so this doesn't bite, but if you ever
   manually set the version (or already ran it with an older schema),
   `DELETE FROM zotero_master.settings WHERE name='schemaVersion'`
   first.
3. **Memcached caches the version for 60s** — restart memcached after
   any DB version change.

```sh
sudo mysql -u zotero zotero_master \
  -e "DELETE FROM settings WHERE name='schemaVersion'"
sudo systemctl restart memcached
PHP=$(sudo systemctl cat zotero-selfhost.service | grep '^ExecStart=' | awk '{print $1}' | sed 's|^ExecStart=||')
cd /var/lib/zotero-selfhost/runtime/dataserver/admin
sudo -u zotero "$PHP" -d "auto_prepend_file=" schema_update
```

Re-run after every `schema.json` refresh.

#### 7. Create an API key for the web library (optional, only needed if you're using the SPA)

Generate a 24-char alphanumeric API key, insert it into
`zotero_master.keys` for user 1 (admin) with library-wide perms, and
remember it for the web library build (step 8).

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
