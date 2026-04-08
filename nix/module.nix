{ config, lib, pkgs, ... }:

let
  cfg = config.services.zotero-selfhost;
  inherit (lib) mkDefault mkEnableOption mkIf mkMerge mkOption optionalString types escapeShellArg nameValuePair mapAttrs';

  php = pkgs.php84.buildEnv {
    extensions = ({ enabled, all }: enabled ++ (with all; [ curl intl mbstring mysqli redis memcached ]));
    extraConfig = ''
      memory_limit = 1G
      max_execution_time = 300
      short_open_tag = On
      display_errors = Off
      error_reporting = E_ALL & ~E_NOTICE & ~E_STRICT & ~E_DEPRECATED
      ; htdocs/index.php does `require('config/routes.inc.php')` and uses
      ; constants defined in include/header.inc.php — both need to be on the
      ; include path. Without auto_prepend_file the runtime sees Z_ENV_*
      ; constants as undefined and returns silent HTTP 500 (display_errors
      ; is Off and `php -S` swallows stderr). The upstream Apache config
      ; auto-prepends header.inc.php; `php -S` doesn't unless the ini says
      ; so explicitly.
      include_path = ".:${dataserverRuntime}/htdocs:${dataserverRuntime}/include"
      auto_prepend_file = "${dataserverRuntime}/include/header.inc.php"
    '';
  };

  # Patches applied to the upstream zotero/stream-server source. The
  # only patch (0001) replaces `uws` (an abandoned native µWebSockets
  # binding with no prebuilt binaries for modern Node and source that no
  # longer compiles against modern Node ABI) with `ws` ^7.5.10. Without
  # this, streamServerNodeDeps' `npm install` either fails outright or
  # silently produces a non-working uws fallback at runtime. The patch
  # also handles `ws` v3+'s removal of the `upgradeReq` property by
  # stashing the request from the connection handler's second arg.
  streamServerPatches = [
    ../src/patches/stream-server/0001-replace-uws-with-ws.patch
  ];

  streamServerNodeDeps = pkgs.stdenvNoCC.mkDerivation {
    pname = "zotero-stream-server-node-deps";
    version = "git";
    src = cfg.streamServerSrc;
    patches = streamServerPatches;
    nativeBuildInputs = [ pkgs.nodejs pkgs.cacert ];
    dontBuild = true;
    dontFixup = true;
    installPhase = ''
      export HOME=$TMPDIR
      export npm_config_cache=$TMPDIR/npm-cache
      # `npm install` instead of `npm ci` because the patch above changes
      # package.json (drops uws, adds ws) and the upstream package-lock.json
      # is now stale; `npm ci` would refuse with EUSAGE. The FOD outputHash
      # still pins the resulting node_modules content for reproducibility.
      npm install --omit=dev --no-audit --no-fund
      cp -r node_modules $out
    '';
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = cfg.streamServerNodeDepsHash;
  };

  streamServerPkg = pkgs.stdenvNoCC.mkDerivation {
    pname = "zotero-selfhost-stream-server";
    version = "git";
    src = cfg.streamServerSrc;
    patches = streamServerPatches;
    nativeBuildInputs = [ pkgs.makeWrapper pkgs.nodejs ];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/libexec/stream-server
      cp -R . $out/libexec/stream-server/
      chmod -R u+w $out/libexec/stream-server
      rm -rf $out/libexec/stream-server/node_modules
      cp -r ${streamServerNodeDeps} $out/libexec/stream-server/node_modules
      makeWrapper ${pkgs.nodejs}/bin/node $out/bin/zotero-stream-server \
        --chdir $out/libexec/stream-server \
        --add-flags index.js
      runHook postInstall
    '';
  };

  tinymceNodeDeps = pkgs.stdenvNoCC.mkDerivation {
    pname = "zotero-tinymce-clean-server-node-deps";
    version = "git";
    src = cfg.tinymceCleanServerSrc;
    nativeBuildInputs = [ pkgs.nodejs pkgs.nodejs pkgs.cacert ];
    dontBuild = true;
    dontFixup = true;
    installPhase = ''
      export HOME=$TMPDIR
      export npm_config_cache=$TMPDIR/npm-cache
      npm install --omit=dev
      cp -r node_modules $out
    '';
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = cfg.tinymceNodeDepsHash;
  };

  tinymceCleanServerPkg = pkgs.stdenvNoCC.mkDerivation {
    pname = "zotero-selfhost-tinymce-clean-server";
    version = "git";
    src = cfg.tinymceCleanServerSrc;
    nativeBuildInputs = [ pkgs.makeWrapper pkgs.nodejs ];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/libexec/tinymce-clean-server
      cp -R . $out/libexec/tinymce-clean-server/
      chmod -R u+w $out/libexec/tinymce-clean-server
      rm -rf $out/libexec/tinymce-clean-server/node_modules
      cp -r ${tinymceNodeDeps} $out/libexec/tinymce-clean-server/node_modules
      makeWrapper ${pkgs.nodejs}/bin/node $out/bin/zotero-tinymce-clean-server \
        --chdir $out/libexec/tinymce-clean-server \
        --add-flags server.js
      runHook postInstall
    '';
  };

  # Patches applied to the upstream zotero/dataserver source before composer
  # install + the runtime build. These were originally part of the docker
  # workflow's utils/patch.sh and the nix module wasn't applying them.
  #
  # - 0001: increase rate-limit capacity (web library easily trips the
  #   default; the upstream zotero.org service has a much larger budget).
  # - 0002: AWS SDK use_path_style_endpoint + endpoint pointing at minio.
  # - 0003: extra debug logging in FullText.inc.php — INTENTIONALLY OMITTED
  #   because it no longer applies cleanly to the current pinned dataserver
  #   source. It's just an error_log line and isn't needed for upload.
  # - 0004: rewrite Storage::getUploadBaseURL() to return a minio URL
  #   instead of the hardcoded https://<bucket>.s3.amazonaws.com/.
  #   APPLIED OUT-OF-BAND VIA SED below in dataserverPkg.installPhase
  #   because the upstream patch hardcodes `http://` (it was written for
  #   localhost docker dev with no SSL) and we want `https://` for
  #   production hosts with ACME on the attachments hostname. Sed gives
  #   us the option to substitute the scheme at module-build time.
  # - 0005: rewrite Attachments::generateSignedURL() to return AWS SDK V4
  #   presigned S3 URLs for download URLs (when payload contains 'hash')
  #   instead of the upstream HMAC-signed attachment-proxy format. The
  #   custom proxy format requires a separate proxy service that
  #   upstream zotero/dataserver doesn't open-source and the NixOS
  #   module doesn't ship; presigned URLs let minio validate the V4
  #   signature itself and serve the file directly. Without this, the
  #   web library's PDF reader fails to load any attachment with a
  #   400 from minio (it can't parse the custom URL format).
  dataserverPatches = [
    ../src/patches/dataserver/0001-increase-capacity-and-replenishRate-to-avoid-trigger.patch
    ../src/patches/dataserver/0002-config-aws-for-local-minio-server.patch
    ../src/patches/dataserver/0005-presigned-s3-urls-for-downloads.patch
    ../src/patches/dataserver/0006-remove-storage-quota.patch
    ../src/patches/dataserver/0007-bump-upload-queue-limit.patch
    ../src/patches/dataserver/0008-drop-storage-class-standard-ia.patch
  ];

  composerVendor = pkgs.stdenvNoCC.mkDerivation {
    pname = "zotero-dataserver-composer-deps";
    version = "git";
    src = cfg.dataserverSrc;
    patches = dataserverPatches;
    nativeBuildInputs = [ php pkgs.php84Packages.composer pkgs.cacert ];
    dontBuild = true;
    dontFixup = true;
    installPhase = ''
      export HOME=$TMPDIR
      export COMPOSER_HOME=$TMPDIR/composer
      export COMPOSER_CACHE_DIR=$TMPDIR/composer-cache
      composer install --no-dev --no-interaction --no-progress --prefer-dist
      cp -r vendor $out
    '';
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = cfg.composerVendorHash;
  };

  dataserverPkg = pkgs.stdenvNoCC.mkDerivation {
    pname = "zotero-selfhost-dataserver";
    version = "git";
    src = cfg.dataserverSrc;
    patches = dataserverPatches;
    nativeBuildInputs = [ php pkgs.php84Packages.composer pkgs.rsync ];
    dontBuild = true;
    # The upstream dataserver repo has a dangling symlink (htdocs/schema -> zotero-schema/schema.json)
    # because zotero-schema is a git submodule not included in the GitHub tarball.
    dontCheckForBrokenSymlinks = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/zotero-dataserver
      rsync -a --exclude .git --exclude tests --exclude tmp --exclude vendor ./ $out/share/zotero-dataserver/
      chmod -R u+w $out/share/zotero-dataserver

      # Replace the hardcoded amazonaws.com upload URL with a path-style
      # minio URL. We use the configured scheme (https when ACME is on,
      # http when not) so the browser POST URL matches what nginx serves
      # on the attachments host — without this, the browser PUTs to
      # http://... which 301-redirects to https://, and 301 doesn't
      # preserve the POST body so the upload silently fails. This
      # replaces the upstream patch 0004 which hardcodes http://.
      ${pkgs.gnused}/bin/sed -i \
        's|return "https://" \. Z_CONFIG::\$S3_BUCKET \. "\.s3\.amazonaws\.com/";|return "${cfg.s3.scheme}://" . Z_CONFIG::$S3_ENDPOINT . "/" . Z_CONFIG::$S3_BUCKET . "/";|' \
        $out/share/zotero-dataserver/model/Storage.inc.php

      # Patch 0002 (config-aws-for-local-minio-server) added the AWS SDK
      # endpoint config but hardcoded `http` for the same localhost-dev
      # reason patch 0004 did. Substitute the scheme to match
      # cfg.s3.scheme. Without this, after a successful upload the
      # dataserver does a HEAD request against the http URL (in
      # Storage::registerUpload) which gets 403/301'd by the http
      # listener, and the registration POST returns 500. Symptom: the
      # web library shows "An error occurred" after the multipart POST
      # to minio succeeded with HTTP 201.
      ${pkgs.gnused}/bin/sed -i \
        -e "s|'endpoint' => 'http://'|'endpoint' => '${cfg.s3.scheme}://'|" \
        -e "s|'scheme' => 'http'|'scheme' => '${cfg.s3.scheme}'|" \
        $out/share/zotero-dataserver/include/header.inc.php

      # Convert MySQL 8.0+ row-alias INSERT...ON DUPLICATE KEY UPDATE
      # syntax to the legacy VALUES(col) form that MariaDB still
      # supports. The dataserver was written against MySQL 8 and uses
      #   INSERT INTO storageFileItems (...) VALUES (?,?,?,?) AS new
      #   ON DUPLICATE KEY UPDATE storageFileID=new.storageFileID, ...
      # MariaDB 11.4 (the NixOS default) doesn't recognize the row
      # alias and aborts with "near 'AS new'". This blocks PDF upload
      # registration: the multipart POST to minio succeeds with HTTP
      # 201 but the dataserver's Storage::registerUpload then fails
      # to record the file metadata.
      ${pkgs.gnused}/bin/sed -i \
        -e 's|VALUES (?,?,?,?) AS new|VALUES (?,?,?,?)|' \
        -e 's|storageFileID=new\.storageFileID, mtime=new\.mtime, size=new\.size|storageFileID=VALUES(storageFileID), mtime=VALUES(mtime), size=VALUES(size)|' \
        $out/share/zotero-dataserver/model/Storage.inc.php

      # Extract Zend Framework 1 — bundled in this repo at
      # src/patches/dataserver/Zend.tar.gz. The upstream zotero/dataserver
      # expects ZF1 to live in include/Zend/ but ships an empty Zend/
      # directory (only .gitignore). The docker workflow's utils/patch.sh
      # extracts the tarball after applying patches; do the same here.
      ${pkgs.gnutar}/bin/tar -xzf ${../src/patches/dataserver/Zend.tar.gz} \
        -C $out/share/zotero-dataserver/include/

      # Drop the bundled zotero-schema submodule contents into htdocs/.
      # zotero-schema is a git submodule of the upstream dataserver but
      # GitHub's tarball doesn't include submodules, so the runtime
      # Schema::init() throws "Locales not available" → silent HTTP 500
      # on /itemTypes etc.
      mkdir -p $out/share/zotero-dataserver/htdocs/zotero-schema
      cp ${cfg.zoteroSchemaSrc}/schema.json \
        $out/share/zotero-dataserver/htdocs/zotero-schema/schema.json

      cp -r ${composerVendor} $out/share/zotero-dataserver/vendor
      chmod -R u+w $out/share/zotero-dataserver/vendor
      export HOME=$TMPDIR
      export COMPOSER_HOME=$TMPDIR/composer
      export COMPOSER_CACHE_DIR=$TMPDIR/composer-cache
      cd $out/share/zotero-dataserver
      composer dump-autoload --no-dev --optimize
      runHook postInstall
    '';
  };

  # Python script that rewrites src/html/index.html in the web-library
  # build to substitute our user-config and menu-config blocks. Using
  # a separate file (rather than a heredoc) avoids the Nix `''` string
  # interpolation eating Python's triple-quoted strings.
  webLibraryHtmlPatcher = pkgs.writeText "patch-index-html.py" ''
    import re, sys
    path = sys.argv[1]
    src = open(path).read()
    user_slug = ${"\""}${cfg.webLibrary.userSlug}${"\""}
    user_id   = ${"\""}${cfg.webLibrary.userId}${"\""}
    api_key   = ${"\""}${cfg.webLibrary.apiKey}${"\""}
    new_config = (
        '<script type="application/json" id="zotero-web-library-config">\n'
        '\t\t{\n'
        '\t\t\t"userSlug": "' + user_slug + '",\n'
        '\t\t\t"userId": "' + user_id + '",\n'
        '\t\t\t"apiKey": "' + api_key + '"\n'
        '\t\t}\n'
        '\t</script>'
    )
    src = re.sub(
        r'<script type="application/json" id="zotero-web-library-config">.*?</script>',
        lambda m: new_config,
        src, count=1, flags=re.DOTALL,
    )
    new_menu = (
        '<script type="application/json" id="zotero-web-library-menu-config">\n'
        '\t\t{\n'
        '\t\t\t"desktop": [{ "label": "My Library", "href": "/' + user_slug + '/library", "active": true }],\n'
        '\t\t\t"mobile":  [{ "label": "My Library", "href": "/' + user_slug + '/library", "active": true }]\n'
        '\t\t}\n'
        '\t</script>'
    )
    src = re.sub(
        r'<script type="application/json" id="zotero-web-library-menu-config">.*?</script>',
        lambda m: new_menu,
        src, count=1, flags=re.DOTALL,
    )
    open(path, 'w').write(src)
  '';

  # zotero/web-library SPA build. Wrapped as a fixed-output derivation
  # because the build needs network at multiple stages: npm install for
  # dependencies, build:locale and build:styles-json for fetching CSL
  # styles and locale strings from the internet, etc. The whole build
  # output is hashed via outputHash for reproducibility.
  #
  # Source patches applied via sed in the build script:
  # - src/js/constants/defaults.js: rewrite api.zotero.org → cfg.webLibrary.hostname
  # - src/js/utils.js: rewrite item canonical URL + parser regex
  # - src/html/index.html: replace the demo zotero-web-library-config
  #   block with our userId/userSlug/apiKey, and the menu config with a
  #   single My Library entry
  # - scripts/task-runner.mjs: wrap setRawMode in isTTY guards (so the
  #   interactive task picker doesn't crash when stdin isn't a TTY,
  #   which is the case in the nix build sandbox)
  # - scripts/build.mjs: replace `cp -aL` with `cp -arL` (uutils-coreutils
  #   on NixOS doesn't accept GNU's `-a` shorthand for `-rL`)
  webLibraryPkg = pkgs.stdenvNoCC.mkDerivation {
    pname = "zotero-web-library";
    version = "git";
    src = cfg.webLibrarySrc;
    # curl + unzip are needed by scripts/fetch-or-build-modules.mjs which
    # downloads pre-built reader/pdf-worker/note-editor zips from
    # zotero-download.s3.amazonaws.com. python3 is needed for the
    # webLibraryHtmlPatcher script. cacert is needed for HTTPS fetches
    # (npm registry, zotero-download S3, etc).
    nativeBuildInputs = [
      pkgs.nodejs_20
      pkgs.cacert
      pkgs.gnused
      pkgs.python3
      pkgs.curl
      pkgs.unzip
      pkgs.git  # scripts/fetch-or-build-modules.mjs runs `git rev-parse HEAD` per submodule
    ];
    dontBuild = true;
    dontFixup = true;
    installPhase = ''
      runHook preInstall
      export HOME=$TMPDIR
      export npm_config_cache=$TMPDIR/npm-cache

      # Build script patches (uutils-coreutils + non-TTY stdin)
      ${pkgs.gnused}/bin/sed -i 's|cp -aL|cp -arL|g' scripts/build.mjs
      ${pkgs.gnused}/bin/sed -i \
        -e 's|process.stdin.setRawMode(true);|if (process.stdin.isTTY) process.stdin.setRawMode(true);|' \
        -e 's|process.stdin.setRawMode(false);|if (process.stdin.isTTY) process.stdin.setRawMode(false);|' \
        scripts/task-runner.mjs

      # Source patches: URLs and item canonical regex
      ${pkgs.gnused}/bin/sed -i \
        -e "s|apiAuthorityPart: 'api.zotero.org'|apiAuthorityPart: '${cfg.webLibrary.hostname}'|" \
        -e "s|export const websiteUrl = 'https://www.zotero.org/'|export const websiteUrl = 'https://${cfg.webLibrary.hostname}/'|" \
        -e "s|export const streamingApiUrl = 'wss://stream.zotero.org/'|export const streamingApiUrl = 'wss://${cfg.webLibrary.hostname}/stream/'|" \
        src/js/constants/defaults.js

      ${pkgs.gnused}/bin/sed -i \
        -e "s|http://zotero.org/|https://${cfg.webLibrary.hostname}/|g" \
        -e "s|https?://zotero.org/|https?://(?:zotero\\\\.org\\|${pkgs.lib.replaceStrings ["."] ["\\\\."] cfg.webLibrary.hostname})/|g" \
        src/js/utils.js

      # Inject the user's config + minimal menu into the demo index.html
      # via a python helper. The upstream config blocks are multiline
      # JSON that's awkward to match with sed.
      ${pkgs.python3}/bin/python3 ${webLibraryHtmlPatcher} src/html/index.html

      # Install + build. --ignore-scripts because some npm packages have
      # postinstall hooks that use `#!/usr/bin/env <foo>` shebangs
      # which fail in the nix sandbox (no /usr/bin/env). After install
      # we patchShebangs the node_modules tree to rewrite all
      # `#!/usr/bin/env` lines to absolute store paths.
      npm install --no-audit --no-fund --legacy-peer-deps --ignore-scripts
      patchShebangs node_modules

      # Run the prepare tasks individually rather than via npm run build
      # so we get real stdout/stderr instead of the task-runner's
      # truncated one-liner. Order doesn't matter (they're parallelizable).
      mkdir -p build/static/web-library/
      node scripts/store-version.mjs
      node scripts/collect-locale.mjs
      node scripts/fetch-or-build-modules.mjs
      node scripts/fetch-fonts.mjs
      node scripts/build-styles-json.mjs
      node scripts/check-icons.mjs
      node scripts/prepare-citeproc-js.mjs

      # Build steps
      NODE_ENV=production npx rollup -c
      for f in src/scss/*.scss; do
        npx sass --no-source-map "$f" "build/static/web-library/$(basename "$f" .scss).css"
      done
      mkdir -p build/
      cp -arL src/html/* build/
      mkdir -p build/static/web-library/
      cp -arL src/static/* build/static/web-library/
      npx postcss build/static/web-library/zotero-web-library.css --use autoprefixer --no-map -r

      mkdir -p $out
      cp -r build/* $out/
      runHook postInstall
    '';
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = cfg.webLibraryHash;
  };

  dataDir = cfg.stateDir;
  runtimeDir = "${cfg.stateDir}/runtime";
  dataserverRuntime = "${runtimeDir}/dataserver";
  streamRuntime = "${runtimeDir}/stream-server";
  tinymceRuntime = "${runtimeDir}/tinymce-clean-server";
  secretName = suffix: "${cfg.secretPrefix}/${suffix}";
  secretKeys = {
    authSalt = secretName "auth-salt";
    superUserPassword = secretName "superuser-password";
    mysqlPassword = secretName "mysql-password";
    s3AccessKey = secretName "s3-access-key";
    s3SecretKey = secretName "s3-secret-key";
    attachmentProxySecret = secretName "attachment-proxy-secret";
  };
  secretPath = key: config.sops.secrets."${key}".path;

  writeDataserverConfig = pkgs.writeShellScript "zotero-write-dataserver-config" ''
    set -euo pipefail

    target_dir="$1"

    read_secret() {
      tr -d '\n' < "$1"
    }

    php_escape() {
      printf '%s' "$1" | ${pkgs.gnused}/bin/sed -e "s/\\\\/\\\\\\\\/g" -e "s/'/\\\\'/g"
    }

    auth_salt="$(read_secret ${escapeShellArg (secretPath secretKeys.authSalt)})"
    superuser_password="$(read_secret ${escapeShellArg (secretPath secretKeys.superUserPassword)})"
    mysql_password="$(read_secret ${escapeShellArg (secretPath secretKeys.mysqlPassword)})"
    s3_access_key="$(read_secret ${escapeShellArg (secretPath secretKeys.s3AccessKey)})"
    s3_secret_key="$(read_secret ${escapeShellArg (secretPath secretKeys.s3SecretKey)})"
    attachment_proxy_secret="$(read_secret ${escapeShellArg (secretPath secretKeys.attachmentProxySecret)})"

    cat > "$target_dir/config.inc.php" <<EOF
    <?
    class Z_CONFIG {
      public static \$API_ENABLED = true;
      public static \$READ_ONLY = false;
      public static \$MAINTENANCE_MESSAGE = 'Server updates in progress. Please try again in a few minutes.';
      public static \$BACKOFF = 0;
      public static \$TESTING_SITE = false;
      public static \$DEV_SITE = false;
      public static \$DEBUG_LOG = true;

      public static \$BASE_URI = '${cfg.baseUri}';
      public static \$API_BASE_URI = '${cfg.baseUri}/';
      public static \$WWW_BASE_URI = '${cfg.baseUri}/';

      public static \$AUTH_SALT = '$(php_escape "$auth_salt")';
      public static \$API_SUPER_USERNAME = '${cfg.superUser.name}';
      public static \$API_SUPER_PASSWORD = '$(php_escape "$superuser_password")';

      public static \$AWS_REGION = '${cfg.s3.region}';
      public static \$AWS_ACCESS_KEY = '$(php_escape "$s3_access_key")';
      public static \$AWS_SECRET_KEY = '$(php_escape "$s3_secret_key")';
      public static \$S3_BUCKET = '${cfg.s3.bucket}';
      public static \$S3_ENDPOINT = '${cfg.s3.endpoint}';
      public static \$S3_BUCKET_CACHE = "";
      public static \$S3_BUCKET_FULLTEXT = '${cfg.s3.fulltextBucket}';
      public static \$SNS_ALERT_TOPIC = "";

      public static \$REDIS_HOSTS = [
        'default' => [ 'host' => '${cfg.redisHost}' ],
        'request-limiter' => [ 'host' => '${cfg.redisHost}' ],
        'notifications' => [ 'host' => '${cfg.redisHost}' ],
        'fulltext-migration' => [ 'host' => '${cfg.redisHost}', 'cluster' => false ]
      ];

      public static \$REDIS_PREFIX = "";

      public static \$MEMCACHED_ENABLED = true;
      public static \$MEMCACHED_SERVERS = [ '${cfg.memcachedHost}:${toString cfg.memcachedPort}:1' ];

      public static \$TRANSLATION_SERVERS = [ 'http://translation1.localdomain:1969' ];
      public static \$CITATION_SERVERS = [ 'citeserver1.localdomain:8080', 'citeserver2.localdomain:8080' ];
      public static \$SEARCH_HOSTS = [ '${cfg.elasticsearchHost}' ];
      public static \$GLOBAL_ITEMS_URL = "";

      public static \$ATTACHMENT_PROXY_URL = '${cfg.attachmentProxyUrl}';
      public static \$ATTACHMENT_PROXY_SECRET = '$(php_escape "$attachment_proxy_secret")';

      public static \$STATSD_ENABLED = false;
      public static \$STATSD_PREFIX = "";
      public static \$STATSD_HOST = 'monitor.localdomain';
      public static \$STATSD_PORT = 8125;

      public static \$LOG_TO_SCRIBE = false;
      public static \$LOG_ADDRESS = "";
      public static \$LOG_PORT = 1463;
      public static \$LOG_TIMEZONE = 'US/Eastern';
      public static \$LOG_TARGET_DEFAULT = 'errors';

      public static \$HTMLCLEAN_SERVER_URL = 'http://${cfg.listenAddress}:${toString cfg.tinymcePort}';
      public static \$CLI_PHP_PATH = '${php}/bin/php';
      public static \$ERROR_PATH = '${dataDir}/errors/';

      public static \$CACHE_VERSION_ATOM_ENTRY = 1;
      public static \$CACHE_VERSION_BIB = 1;
      public static \$CACHE_VERSION_ITEM_DATA = 1;
      public static \$CACHE_VERSION_RESPONSE_JSON_COLLECTION = 1;
      public static \$CACHE_VERSION_RESPONSE_JSON_ITEM = 1;
    }
    ?>
    EOF

    cat > "$target_dir/dbconnect.inc.php" <<EOF
    <?
    function Zotero_dbConnectAuth(\$db) {
      \$charset = "";

      if (\$db == 'master') {
        \$host = '${cfg.mysql.host}';
        \$port = ${toString cfg.mysql.port};
        \$db = '${cfg.mysql.masterDb}';
        \$user = '${cfg.mysql.user}';
        \$pass = '$(php_escape "$mysql_password")';
        \$state = 'up';
      }
      else if (\$db == 'shard') {
        \$host = '${cfg.mysql.host}';
        \$port = ${toString cfg.mysql.port};
        \$db = '${cfg.mysql.shardDb}';
        \$user = '${cfg.mysql.user}';
        \$pass = '$(php_escape "$mysql_password")';
      }
      else if (\$db == 'id1' || \$db == 'id2') {
        \$host = '${cfg.mysql.host}';
        \$port = ${toString cfg.mysql.port};
        \$db = '${cfg.mysql.idsDb}';
        \$user = '${cfg.mysql.user}';
        \$pass = '$(php_escape "$mysql_password")';
      }
      else if (\$db == 'www1' || \$db == 'www2') {
        \$host = '${cfg.mysql.host}';
        \$port = ${toString cfg.mysql.port};
        \$db = '${cfg.mysql.wwwDb}';
        \$user = '${cfg.mysql.user}';
        \$pass = '$(php_escape "$mysql_password")';
      }
      else {
        throw new Exception("Invalid db '\$db'");
      }

      return [
        'host' => \$host,
        'replicas' => !empty(\$replicas) ? \$replicas : [],
        'port' => \$port,
        'db' => \$db,
        'user' => \$user,
        'pass' => \$pass,
        'charset' => \$charset,
        'state' => !empty(\$state) ? \$state : 'up'
      ];
    }
    ?>
    EOF
  '';

  streamConfig = pkgs.writeText "default.js" ''
    var os = require("os");

    module.exports = {
      dev: false,
      logLevel: 'info',
      hostname: os.hostname().split('.')[0],
      httpPort: ${toString cfg.streamPort},
      proxyProtocol: false,
      https: false,
      trustedProxies: [],
      statusInterval: 10,
      keepaliveInterval: 25,
      retryTime: 10,
      shutdownDelay: 100,
      redis: {
        host: '${cfg.redisHost}',
        prefix: ""
      },
      apiURL: 'http://${cfg.listenAddress}:${toString cfg.listenPort}/',
      apiVersion: 3,
      apiRequestHeaders: {},
      longStackTraces: false,
      globalTopics: [ 'styles', 'translators' ],
      globalTopicsMinDelay: 30 * 1000,
      globalTopicsDelayPeriod: 60 * 1000,
      continuedDelayDefault: 3 * 1000,
      continuedDelay: 30 * 1000,
      statsD: {
        host: ""
      }
    };
  '';

  initScript = pkgs.writeShellApplication {
    name = "zotero-selfhost-init";
    runtimeInputs = [ pkgs.mysql84 pkgs.awscli2 ];
    text = ''
      set -euo pipefail

      read_secret() {
        tr -d '\n' < "$1"
      }

      sql_escape() {
        printf '%s' "$1" | ${pkgs.perl}/bin/perl -pe 's/\x27/\x27\x27/g'
      }

      MYSQL_PWD="$(read_secret ${escapeShellArg (secretPath secretKeys.mysqlPassword)})"
      export MYSQL_PWD
      MYSQL_HOST=${lib.escapeShellArg cfg.mysql.host}
      MYSQL_PORT=${toString cfg.mysql.port}
      MYSQL_USER=${lib.escapeShellArg cfg.mysql.user}
      misc=${dataserverPkg}/share/zotero-dataserver/misc
      superuser_password_sql="$(sql_escape "$(read_secret ${escapeShellArg (secretPath secretKeys.superUserPassword)})")"
      superuser_name_sql="$(sql_escape ${escapeShellArg cfg.superUser.name})"
      superuser_email_sql="$(sql_escape ${escapeShellArg cfg.superUser.email})"

      mysql_base() {
        mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" "$@"
      }

      # innodb_large_prefix was removed in MariaDB 10.5+; DYNAMIC row
      # format is the default now and the variable no longer exists.
      # Setting it returns "Unknown system variable" and aborts the
      # init script. Skip on modern MariaDB.
      echo 'set global sql_mode = "";' | mysql_base

      for db in ${cfg.mysql.masterDb} ${cfg.mysql.shardDb} zotero_shard_2 ${cfg.mysql.idsDb} ${cfg.mysql.wwwDb}; do
        echo "DROP DATABASE IF EXISTS $db" | mysql_base
      done
      for db in ${cfg.mysql.masterDb} ${cfg.mysql.shardDb} zotero_shard_2 ${cfg.mysql.idsDb} ${cfg.mysql.wwwDb}; do
        echo "CREATE DATABASE $db" | mysql_base
      done

      mysql_base ${cfg.mysql.masterDb} < "$misc/master.sql"
      mysql_base ${cfg.mysql.masterDb} < "$misc/coredata.sql"
      echo "INSERT INTO shardHosts VALUES (1, '${cfg.mysql.host}', ${toString cfg.mysql.port}, 'up');" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO shards VALUES (1, 1, '${cfg.mysql.shardDb}', 'up', '1');" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO shards VALUES (2, 1, 'zotero_shard_2', 'up', '1');" | mysql_base ${cfg.mysql.masterDb}
      # libraries schema has 6 columns (libraryID, libraryType, lastUpdated,
      # version, shardID, hasData). The previous unnamed-column INSERT
      # provided 5 values and aborted with "Column count doesn't match".
      echo "INSERT INTO libraries (libraryID, libraryType, lastUpdated, version, shardID, hasData) VALUES (1, 'user', CURRENT_TIMESTAMP, 0, 1, 0)" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO libraries (libraryID, libraryType, lastUpdated, version, shardID, hasData) VALUES (2, 'group', CURRENT_TIMESTAMP, 0, 2, 0)" | mysql_base ${cfg.mysql.masterDb}
      # zotero_master.users schema has 3 columns (userID, libraryID,
      # username). The previous INSERT provided 5 values including
      # timestamps that aren't part of the table. Use named columns.
      echo "INSERT INTO users (userID, libraryID, username) VALUES (1, 1, '$superuser_name_sql')" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO groups VALUES (1, 2, 'Shared', 'shared', 'Private', 'members', 'all', 'members', \"\", \"\", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO groupUsers VALUES (1, 1, 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)" | mysql_base ${cfg.mysql.masterDb}

      mysql_base ${cfg.mysql.wwwDb} < ${cfg.wwwSql}
      # The dataserver's storage quota check (Storage::getInstitutionalUserQuota)
      # joins users_email to storage_institutions WHERE validated=1, but the
      # bundled www.sql doesn't include a `validated` column. Add it after
      # loading the schema and mark our seeded admin email as validated.
      echo "ALTER TABLE users_email ADD COLUMN validated TINYINT(1) NOT NULL DEFAULT 0 AFTER email" | mysql_base ${cfg.mysql.wwwDb}
      echo "INSERT INTO users VALUES (1, '$superuser_name_sql', MD5('$superuser_password_sql'), 'normal')" | mysql_base ${cfg.mysql.wwwDb}
      echo "INSERT INTO users_email (userID, email, validated) VALUES (1, '$superuser_email_sql', 1)" | mysql_base ${cfg.mysql.wwwDb}
      echo "INSERT INTO storage_institutions (institutionID, domain, storageQuota) VALUES (1, 'zotero.org', 10000)" | mysql_base ${cfg.mysql.wwwDb}
      echo "INSERT INTO storage_institution_email (institutionID, email) VALUES (1, 'contact@zotero.org')" | mysql_base ${cfg.mysql.wwwDb}

      for shard in ${cfg.mysql.shardDb} zotero_shard_2; do
        mysql_base "$shard" < "$misc/shard.sql"
        mysql_base "$shard" < "$misc/triggers.sql"
      done
      # shardLibraries schema has 5 columns (libraryID, libraryType,
      # lastUpdated, version, storageUsage). Previous INSERT provided 4.
      echo "INSERT INTO shardLibraries (libraryID, libraryType, lastUpdated, version, storageUsage) VALUES (1, 'user', CURRENT_TIMESTAMP, 0, 0)" | mysql_base ${cfg.mysql.shardDb}
      echo "INSERT INTO shardLibraries (libraryID, libraryType, lastUpdated, version, storageUsage) VALUES (2, 'group', CURRENT_TIMESTAMP, 0, 0)" | mysql_base zotero_shard_2
      mysql_base ${cfg.mysql.idsDb} < "$misc/ids.sql"

      # Ingest the schema.json mappings (item types, fields, creator
      # types, locales) into the dataserver tables. Without this, write
      # operations fail with "Field 'X' from schema N not found in
      # ItemFields.inc.php" because coredata.sql only ships an old
      # schema. The php here uses -d auto_prepend_file= to override the
      # auto_prepend in php.ini (admin/schema_update has its own
      # require('header.inc.php'), so without disabling auto_prepend
      # the function gets declared twice → fatal redeclare).
      ${php}/bin/php -d "auto_prepend_file=" \
        ${dataserverPkg}/share/zotero-dataserver/admin/schema_update || true

      ${optionalString (cfg.s3.createBuckets && cfg.s3.endpointUrl != null) ''
        AWS_ACCESS_KEY_ID="$(read_secret ${escapeShellArg (secretPath secretKeys.s3AccessKey)})"
        export AWS_ACCESS_KEY_ID
        AWS_SECRET_ACCESS_KEY="$(read_secret ${escapeShellArg (secretPath secretKeys.s3SecretKey)})"
        export AWS_SECRET_ACCESS_KEY
        AWS_DEFAULT_REGION=${lib.escapeShellArg cfg.s3.region}
        export AWS_DEFAULT_REGION
        aws --endpoint-url ${lib.escapeShellArg cfg.s3.endpointUrl} s3 mb s3://${cfg.s3.bucket} || true
        aws --endpoint-url ${lib.escapeShellArg cfg.s3.endpointUrl} s3 mb s3://${cfg.s3.fulltextBucket} || true
      ''}
    '';
  };

  createUserScript = pkgs.writeShellApplication {
    name = "zotero-selfhost-create-user";
    runtimeInputs = [ pkgs.mysql84 ];
    text = ''
      set -euo pipefail
      if [ "$#" -lt 4 ]; then
        echo "Usage: zotero-selfhost-create-user UID username password email" >&2
        exit 1
      fi

      uid="$1"
      username="$2"
      password="$3"
      email="$4"

      read_secret() {
        tr -d '\n' < "$1"
      }

      sql_escape() {
        printf '%s' "$1" | ${pkgs.perl}/bin/perl -pe 's/\x27/\x27\x27/g'
      }

      MYSQL_PWD="$(read_secret ${escapeShellArg (secretPath secretKeys.mysqlPassword)})"
      export MYSQL_PWD
      MYSQL_HOST=${lib.escapeShellArg cfg.mysql.host}
      MYSQL_PORT=${toString cfg.mysql.port}
      MYSQL_USER=${lib.escapeShellArg cfg.mysql.user}
      username_sql="$(sql_escape "$username")"
      password_sql="$(sql_escape "$password")"
      email_sql="$(sql_escape "$email")"

      mysql_base() {
        mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" "$@"
      }

      # All four INSERTs below were broken against the current dataserver
      # schema (column counts didn't match). They've been rewritten to use
      # named columns to be robust against future schema additions and to
      # match the column-count fixes in initScript above.
      echo "INSERT INTO libraries (libraryID, libraryType, lastUpdated, version, shardID, hasData) VALUES ($uid, 'user', CURRENT_TIMESTAMP, 0, 1, 0)" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO users (userID, libraryID, username) VALUES ($uid, $uid, '$username_sql')" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO groupUsers VALUES (1, $uid, 'member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO users VALUES ($uid, '$username_sql', MD5('$password_sql'), 'normal')" | mysql_base ${cfg.mysql.wwwDb}
      echo "INSERT INTO users_email (userID, email, validated) VALUES ($uid, '$email_sql', 1)" | mysql_base ${cfg.mysql.wwwDb}
      echo "INSERT INTO shardLibraries (libraryID, libraryType, lastUpdated, version, storageUsage) VALUES ($uid, 'user', CURRENT_TIMESTAMP, 0, 0)" | mysql_base ${cfg.mysql.shardDb}
    '';
  };

  syncRuntime = src: dst: ''
    ${pkgs.coreutils}/bin/mkdir -p ${lib.escapeShellArg dst}
    ${pkgs.rsync}/bin/rsync -a --delete ${lib.escapeShellArg (src + "/")} ${lib.escapeShellArg (dst + "/")}
    ${pkgs.coreutils}/bin/chmod -R u+rwX ${lib.escapeShellArg dst}
  '';

in {
  options.services.zotero-selfhost = {
    enable = mkEnableOption "Zotero Selfhost";

    dataserverSrc = mkOption {
      type = types.path;
      default = pkgs.fetchFromGitHub {
        owner = "zotero";
        repo = "dataserver";
        rev = "4ce766d98c8f222a0ee41cdfac26d2c18cc26078";
        sha256 = "092wghpy4227zxn7hzbd5zw80rxw8nlbjl5axlf93fr1dh4zrbw3";
      };
      description = "Path to the Zotero dataserver source tree.";
    };

    composerVendorHash = mkOption {
      type = types.str;
      default = "sha256-ranFTRff1xLMrsgdw6jZLCUKv8MUSpI2ttEFiuqmcbE=";
      description = "SRI hash of the pre-fetched Composer vendor directory for the dataserver.";
    };

    streamServerNodeDepsHash = mkOption {
      type = types.str;
      default = "sha256-w0KmEH47XGW4MRfndk9r7c2I37QzFXRXwj05YslVVdw=";
      description = ''
        SRI hash of the pre-fetched node_modules for the stream server.
        When you bump streamServerSrc or streamServerPatches, set this
        to lib.fakeHash temporarily, run nixos-rebuild, copy the real
        hash from the "got:" line in the error, and set it here.
      '';
    };

    tinymceNodeDepsHash = mkOption {
      type = types.str;
      default = "sha256-9sgdwd9AJZYi5eLu+0Ca+oqG+MwGEkJO+xIfIekmLLw=";
      description = "SRI hash of the pre-fetched node_modules for the TinyMCE clean server.";
    };

    streamServerSrc = mkOption {
      type = types.path;
      default = pkgs.fetchFromGitHub {
        owner = "zotero";
        repo = "stream-server";
        rev = "7e2e57d49ad300dd595ab9e239afe908525097b4";
        sha256 = "1ip5ljcywxk38c1n3g25qilvwvxh56aif0a1sc8w04hdiz1w2fib";
      };
      description = "Path to the Zotero stream-server source tree.";
    };

    tinymceCleanServerSrc = mkOption {
      type = types.path;
      default = pkgs.fetchFromGitHub {
        owner = "zotero";
        repo = "tinymce-clean-server";
        rev = "5be2a0d367133b728872bee9975beed1c9e74898";
        sha256 = "0hyzr3xnhw5n6ds7z1mvll7kh83pas44jdywvrgi2f7wykmklzhi";
      };
      description = "Path to the Zotero TinyMCE clean server source tree.";
    };

    zoteroSchemaSrc = mkOption {
      type = types.path;
      default = pkgs.fetchFromGitHub {
        owner = "zotero";
        repo = "zotero-schema";
        rev = "62e983a2e575fe9b9a3677ad7c9772080b67a1e4";
        sha256 = "0yqsij69k6ssjs8nbha8bnx4lvk8k6nqg286v0a8awqgb2srimd1";
      };
      description = ''
        Path to the zotero-schema source tree (must contain schema.json).
        zotero-schema is a git submodule of upstream zotero/dataserver but
        GitHub's source tarball doesn't include submodules, so we fetch it
        separately and copy schema.json into htdocs/zotero-schema/ at build
        time. Without this, Schema::init() throws "Locales not available"
        and /itemTypes returns silent HTTP 500.
      '';
    };

    webLibrarySrc = mkOption {
      type = types.path;
      default = pkgs.fetchgit {
        url = "https://github.com/zotero/web-library.git";
        rev = "1e95df8a6f0ac088d84ce103ec486028f294f8f1";  # main HEAD as of 2026-04-08
        # leaveDotGit so scripts/fetch-or-build-modules.mjs can call
        # `git rev-parse HEAD` inside each modules/<submodule> dir to
        # determine the matching prebuild artifact URL on
        # zotero-download.s3.amazonaws.com.
        leaveDotGit = true;
        sha256 = "sha256-x2tLXabG0A5Q0xDBuCjzNjvG2BJt1oB1fx0uxmGKM5Y=";
        fetchSubmodules = true;
      };
      description = ''
        Path to the zotero/web-library source tree (with submodules).
        zotero/web-library has 6 git submodules (reader, pdf-worker,
        note-editor, web-common, zotero-schema, locales) which are
        required at build time. Use pkgs.fetchgit { fetchSubmodules =
        true; ... } to fetch them — pkgs.fetchFromGitHub does not
        currently support fetchSubmodules in nixos-25.05.

        We pin to a recent main HEAD rather than the v1.7.5 tag because
        the tagged release has a different scripts/ layout that doesn't
        match the build patches in webLibraryPkg.
      '';
    };

    webLibraryHash = mkOption {
      type = types.str;
      default = "sha256-Cu2gPzmcPeRXSqhi7NNGF0LMASb/fP6JX+eLBx3rqxo=";
      description = ''
        SRI hash of the built web-library bundle (the result of
        `npm install && npm run build`). The build is wrapped as a
        fixed-output derivation because it needs network access at
        build time (npm registry, fonts, citation styles, locales).
        When you bump webLibrarySrc or change a webLibrary option that
        affects the build, set this to lib.fakeHash temporarily,
        rebuild to discover the real hash from the "got:" line in the
        error, and set it here.
      '';
    };

    wwwSql = mkOption {
      type = types.path;
      default = ../config/dataserver-scripts/www.sql;
      description = "Path to the www.sql bootstrap schema file.";
    };

    user = mkOption {
      type = types.str;
      default = "zotero";
    };

    group = mkOption {
      type = types.str;
      default = "zotero";
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/zotero-selfhost";
    };

    sopsFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "SOPS file containing Zotero Selfhost secrets.";
    };

    secretPrefix = mkOption {
      type = types.str;
      default = "zotero-selfhost";
      description = "Prefix used for SOPS secret keys, e.g. zotero-selfhost/mysql-password.";
    };

    baseUri = mkOption {
      type = types.str;
      default = "http://127.0.0.1:8080";
    };

    listenAddress = mkOption {
      type = types.str;
      default = "127.0.0.1";
    };

    listenPort = mkOption {
      type = types.port;
      default = 8080;
    };

    streamPort = mkOption {
      type = types.port;
      default = 8081;
    };

    tinymcePort = mkOption {
      type = types.port;
      default = 16342;
    };

    authSalt = mkOption {
      type = types.nullOr types.str;
      default = null;
      visible = false;
      description = "Deprecated plaintext secret. Use sopsFile instead.";
    };

    superUser = {
      name = mkOption { type = types.str; default = "admin"; };
      password = mkOption {
        type = types.nullOr types.str;
        default = null;
        visible = false;
        description = "Deprecated plaintext secret. Use sopsFile instead.";
      };
      email = mkOption { type = types.str; default = "admin@zotero.org"; };
    };

    mysql = {
      host = mkOption { type = types.str; default = "127.0.0.1"; };
      port = mkOption { type = types.port; default = 3306; };
      user = mkOption { type = types.str; default = "root"; };
      password = mkOption {
        type = types.nullOr types.str;
        default = null;
        visible = false;
        description = "Deprecated plaintext secret. Use sopsFile instead.";
      };
      masterDb = mkOption { type = types.str; default = "zotero_master"; };
      shardDb = mkOption { type = types.str; default = "zotero_shard_1"; };
      idsDb = mkOption { type = types.str; default = "zotero_ids"; };
      wwwDb = mkOption { type = types.str; default = "zotero_www"; };
    };

    redisHost = mkOption {
      type = types.str;
      default = "127.0.0.1";
    };

    memcachedHost = mkOption {
      type = types.str;
      default = "127.0.0.1";
    };

    memcachedPort = mkOption {
      type = types.port;
      default = 11211;
    };

    elasticsearchHost = mkOption {
      type = types.str;
      default = "127.0.0.1";
    };

    s3 = {
      accessKey = mkOption {
        type = types.nullOr types.str;
        default = null;
        visible = false;
        description = "Deprecated plaintext secret. Use sopsFile instead.";
      };
      secretKey = mkOption {
        type = types.nullOr types.str;
        default = null;
        visible = false;
        description = "Deprecated plaintext secret. Use sopsFile instead.";
      };
      region = mkOption { type = types.str; default = "us-east-1"; };
      endpoint = mkOption { type = types.str; default = "127.0.0.1:9000"; };
      endpointUrl = mkOption { type = types.nullOr types.str; default = null; };
      scheme = mkOption {
        type = types.enum [ "http" "https" ];
        default = "https";
        description = ''
          URL scheme returned to clients in storage upload URLs. Should be
          `https` whenever the attachments host is served behind nginx with
          ACME (the default for `infrastructure.enable = true`); `http` is
          only appropriate for local docker dev with no SSL because the
          browser POST upload body would otherwise be lost across the
          301 redirect that nginx serves on the http listener.
        '';
      };
      bucket = mkOption { type = types.str; default = "zotero"; };
      fulltextBucket = mkOption { type = types.str; default = "zotero-fulltext"; };
      createBuckets = mkOption { type = types.bool; default = false; };
    };

    attachmentProxyUrl = mkOption {
      type = types.str;
      default = "https://files.example.com/";
    };

    infrastructure = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Provision an opinionated local dependency stack with MySQL, Redis, Memcached, OpenSearch, MinIO, and nginx reverse proxying.";
      };

      hostname = mkOption {
        type = types.str;
        default = "zotero.tuckerbradford.com";
        description = "Primary public hostname for the Zotero dataserver and stream endpoint.";
      };

      attachmentsHostname = mkOption {
        type = types.str;
        default = "attachments.zotero.tuckerbradford.com";
        description = "Public hostname that reverse proxies MinIO for attachment download URLs.";
      };

      attachmentMaxBodySize = mkOption {
        type = types.str;
        default = "2g";
        description = ''
          nginx `client_max_body_size` value applied to the attachments
          vhost. nginx's default of 1m would silently reject any Zotero
          PDF over 1 MB with HTTP 413. The default here (2g) covers
          everything reasonable while still capping pathological uploads.
        '';
      };

      enableACME = mkOption {
        type = types.bool;
        default = false;
        description = "Whether to request ACME certificates for the nginx virtual hosts.";
      };

      forceSSL = mkOption {
        type = types.bool;
        default = false;
        description = "Whether nginx should redirect HTTP to HTTPS for the Zotero and attachment hosts.";
      };

      openFirewall = mkOption {
        type = types.bool;
        default = true;
        description = "Open ports 80 and 443 when the integrated nginx reverse proxy is enabled.";
      };

      mysqlPackage = mkOption {
        type = types.package;
        default = pkgs.mysql84;
        description = "MySQL package to use for the integrated database service.";
      };

      opensearchPort = mkOption {
        type = types.port;
        default = 9200;
        description = "Loopback HTTP port for the integrated OpenSearch service.";
      };

      minioPort = mkOption {
        type = types.port;
        default = 9000;
        description = "Loopback API port for the integrated MinIO service.";
      };

      minioConsolePort = mkOption {
        type = types.port;
        default = 9001;
        description = "Loopback console port for the integrated MinIO service.";
      };

      minio = {
        enable = mkOption {
          type = types.bool;
          default = true;
          description = ''
            Whether to provision the bundled MinIO instance as part of the
            integrated infrastructure stack. Set to false when you already
            have an S3-compatible backend (e.g. another minio, AWS S3, R2,
            B2) and want the dataserver to use it instead. When disabled,
            you must explicitly set `services.zotero-selfhost.s3.endpointUrl`
            and provide credentials in the sops file matching whatever
            backend you're pointing at. The dataserver will not wait for
            `zotero-selfhost-minio.service` at startup, and the integrated
            nginx attachments vhost will reverse-proxy to whatever
            `s3.endpointUrl` resolves to.
          '';
        };
      };
    };

    webLibrary = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Build and serve zotero/web-library at the configured hostname.
          When enabled, the SPA is served from / on the same vhost as
          the dataserver API, with the dataserver API paths
          (/users, /groups, /itemTypes, etc) carved out via a regex
          location that takes precedence over the SPA root location.
          The SPA's React Router uses root-relative paths
          (/<userSlug>/items/<key>/reader, etc), so it MUST be mounted
          at root — not under a sub-path — or internal navigation will
          break on refresh.
        '';
      };

      hostname = mkOption {
        type = types.str;
        default = cfg.infrastructure.hostname;
        description = "Public hostname to serve the web library SPA on.";
      };

      apiKey = mkOption {
        type = types.str;
        example = "4YG74kzuoCxVsnSBdBrBauul";
        description = ''
          Zotero API key baked into the SPA build's index.html config
          block. The SPA will use this key for all API requests. The
          key must already exist in zotero_master.keys with library
          permissions on the user's library; see README "Manual setup
          steps" → "Create an API key for the web library".

          NOTE: this string is baked into the JS bundle and visible to
          anyone who can fetch /static/web-library/zotero-web-library.js.
          Use basicAuthFile to gate access to the bundle, OR put a
          per-user OAuth proxy in front. For multi-user web access
          you'd need a separate build per user — the upstream SPA has
          no runtime apiKey injection.
        '';
      };

      userId = mkOption {
        type = types.str;
        default = "1";
        description = "Numeric Zotero user ID for the SPA's default library view.";
      };

      userSlug = mkOption {
        type = types.str;
        default = "admin";
        description = ''
          Username slug for the SPA's default library view. Must match
          the `username` of the corresponding row in zotero_master.users.
          Don't use a slug that collides with a dataserver API path
          prefix (users, groups, itemTypes, itemFields, creatorFields,
          itemTypeFields, itemTypeCreatorTypes, keys, login,
          storagepurge, test, tts, items, globalitems) — the regex
          location for the API will swallow the request before it
          reaches the SPA.
        '';
      };

      basicAuthFile = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "/etc/nginx/htpasswd.zotero-library";
        description = ''
          Path to an htpasswd file that gates access to the web
          library SPA paths (/, /static/web-library/). The dataserver
          API paths stay open so Zotero desktop / mobile clients can
          still sync via Zotero-API-Key headers. Strongly recommended
          for any internet-facing deployment because the apiKey is
          baked into the JS bundle.
        '';
      };
    };
  };

  config = mkIf cfg.enable (mkMerge [
    {
    assertions = [
      {
        assertion = cfg.sopsFile != null;
        message = "services.zotero-selfhost.sopsFile must be set so secrets are provided via sops-nix.";
      }
      {
        assertion = cfg.authSalt == null && cfg.superUser.password == null && cfg.mysql.password == null && cfg.s3.accessKey == null && cfg.s3.secretKey == null;
        message = "Plaintext secret options are deprecated. Move Zotero Selfhost secrets into SOPS and set services.zotero-selfhost.sopsFile.";
      }
    ];

    sops.secrets = mapAttrs' (_: key: nameValuePair key {
      inherit (cfg) sopsFile;
      owner = cfg.user;
      group = cfg.group;
      mode = "0440";
    }) secretKeys;

    users.groups = mkIf (cfg.group == "zotero") {
      zotero = {};
    };

    users.users = mkIf (cfg.user == "zotero") {
      zotero = {
        isSystemUser = true;
        group = cfg.group;
        home = cfg.stateDir;
        createHome = true;
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0750 ${cfg.user} ${cfg.group} - -"
      "d ${cfg.stateDir}/errors 0750 ${cfg.user} ${cfg.group} - -"
      "d ${cfg.stateDir}/tmp 0770 ${cfg.user} ${cfg.group} - -"
      "d ${runtimeDir} 0750 ${cfg.user} ${cfg.group} - -"
      # Pre-create runtime working directories before systemd checks each
      # service's WorkingDirectory= (which is enforced before ExecStartPre
      # runs, so the prepare scripts can never bootstrap them on first
      # start without this).
      "d ${dataserverRuntime} 0755 ${cfg.user} ${cfg.group} - -"
      "d ${dataserverRuntime}/htdocs 0755 ${cfg.user} ${cfg.group} - -"
      "d ${streamRuntime} 0755 ${cfg.user} ${cfg.group} - -"
      "d ${tinymceRuntime} 0755 ${cfg.user} ${cfg.group} - -"
    ];

    environment.systemPackages = [ initScript createUserScript ];

    systemd.services.zotero-selfhost-stream = {
      description = "Zotero Selfhost stream server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = streamRuntime;
        ExecStartPre = pkgs.writeShellScript "zotero-stream-prepare" ''
          set -euo pipefail
          ${syncRuntime "${streamServerPkg}/libexec/stream-server" streamRuntime}
          mkdir -p ${streamRuntime}/config
          ln -sfn ${streamConfig} ${streamRuntime}/config/default.js
        '';
        # Pin the runtime node to v20 LTS. The bundled `node-config` npm
        # package calls `util.isRegExp` which was removed in Node 22+, and
        # `pkgs.nodejs` currently tracks the latest LTS (24 as of 2026-04).
        # Pure-JS deps installed by the FOD wrapper above are portable
        # across node versions, so swapping only the runtime binary
        # suffices and avoids invalidating streamServerNodeDepsHash.
        ExecStart = "${pkgs.nodejs_20}/bin/node ${streamRuntime}/index.js";
        Restart = "always";
        RestartSec = 5;
      };
    };

    systemd.services.zotero-selfhost-tinymce = {
      description = "Zotero Selfhost TinyMCE clean server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = tinymceRuntime;
        Environment = [ "PORT=${toString cfg.tinymcePort}" ];
        ExecStartPre = pkgs.writeShellScript "zotero-tinymce-prepare" ''
          set -euo pipefail
          ${syncRuntime "${tinymceCleanServerPkg}/libexec/tinymce-clean-server" tinymceRuntime}
        '';
        # Same Node 20 pin as the stream server above — see comment there.
        ExecStart = "${pkgs.nodejs_20}/bin/node ${tinymceRuntime}/server.js";
        Restart = "always";
        RestartSec = 5;
      };
    };

    systemd.services.zotero-selfhost = {
      description = "Zotero Selfhost dataserver";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "zotero-selfhost-stream.service"
        "zotero-selfhost-tinymce.service"
      ]
      ++ lib.optionals cfg.infrastructure.enable ([
        "mysql.service"
        "redis-zotero-selfhost.service"
        "memcached.service"
        "opensearch.service"
      ] ++ lib.optional cfg.infrastructure.minio.enable "zotero-selfhost-minio.service");
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = "${dataserverRuntime}/htdocs";
        ExecStartPre = pkgs.writeShellScript "zotero-dataserver-prepare" ''
          set -euo pipefail
          ${syncRuntime "${dataserverPkg}/share/zotero-dataserver" dataserverRuntime}
          mkdir -p ${dataserverRuntime}/include/config
          mkdir -p ${cfg.stateDir}/errors ${cfg.stateDir}/tmp
          ${writeDataserverConfig} ${dataserverRuntime}/include/config
          rm -rf ${dataserverRuntime}/errors ${dataserverRuntime}/tmp
          ln -sfn ${cfg.stateDir}/errors ${dataserverRuntime}/errors
          ln -sfn ${cfg.stateDir}/tmp ${dataserverRuntime}/tmp
        '';
        ExecStart = "${php}/bin/php -S ${cfg.listenAddress}:${toString cfg.listenPort} -t ${dataserverRuntime}/htdocs ${dataserverRuntime}/htdocs/index.php";
        Restart = "always";
        RestartSec = 5;
      };
    };
    }

    (mkIf cfg.infrastructure.enable {
      services.zotero-selfhost = {
        baseUri = mkDefault "https://${cfg.infrastructure.hostname}";
        attachmentProxyUrl = mkDefault "https://${cfg.infrastructure.attachmentsHostname}";

        mysql = {
          host = mkDefault "127.0.0.1";
          port = mkDefault 3306;
          user = mkDefault "root";
        };

        redisHost = mkDefault "127.0.0.1";
        memcachedHost = mkDefault "127.0.0.1";
        memcachedPort = mkDefault 11211;
        elasticsearchHost = mkDefault "127.0.0.1:${toString cfg.infrastructure.opensearchPort}";

        s3 = {
          endpoint = mkDefault cfg.infrastructure.attachmentsHostname;
          endpointUrl = mkDefault "http://127.0.0.1:${toString cfg.infrastructure.minioPort}";
          createBuckets = mkDefault true;
        };
      };

      networking.firewall.allowedTCPPorts = mkIf cfg.infrastructure.openFirewall [ 80 443 ];

      services.mysql = {
        enable = true;
        package = mkDefault cfg.infrastructure.mysqlPackage;
        ensureUsers = [
          {
            name = cfg.mysql.user;
            ensurePermissions = {
              "${cfg.mysql.masterDb}.*" = "ALL PRIVILEGES";
              "${cfg.mysql.shardDb}.*" = "ALL PRIVILEGES";
              "zotero_shard_2.*" = "ALL PRIVILEGES";
              "${cfg.mysql.idsDb}.*" = "ALL PRIVILEGES";
              "${cfg.mysql.wwwDb}.*" = "ALL PRIVILEGES";
            };
          }
        ];
        settings = {
          mysqld = {
            default_authentication_plugin = "mysql_native_password";
            sql_mode = "";
            innodb_large_prefix = 1;
            bind-address = cfg.mysql.host;
            port = cfg.mysql.port;
          };
        };
      };

      services.redis.servers.zotero-selfhost = {
        enable = true;
        bind = cfg.redisHost;
        port = 6379;
      };

      services.memcached = {
        enable = true;
        listen = cfg.memcachedHost;
        port = cfg.memcachedPort;
      };

      services.opensearch = {
        enable = true;
        settings = {
          cluster.name = "zotero-selfhost";
          network.host = "127.0.0.1";
          http.port = cfg.infrastructure.opensearchPort;
          discovery.type = "single-node";
          plugins.security.disabled = true;
        };
      };

      systemd.services.zotero-selfhost-minio = lib.mkIf cfg.infrastructure.minio.enable {
        description = "Zotero Selfhost MinIO object storage";
        wantedBy = [ "multi-user.target" ];
        # Must wait for sops-install-secrets to decrypt the s3 access/secret
        # key files before start. Without this, on a fresh boot the start
        # script reads /run/secrets/zotero-selfhost/s3-{access,secret}-key as
        # empty strings (the files don't exist yet) and minio falls back to
        # its default minioadmin:minioadmin credentials. The dataserver then
        # can't authenticate against minio (it's using the sops credentials)
        # and PDF uploads return 403 InvalidAccessKeyId from minio.
        after = [ "network.target" "sops-install-secrets.service" ];
        wants = [ "sops-install-secrets.service" ];
        serviceConfig = {
          Type = "simple";
          User = cfg.user;
          Group = cfg.group;
          WorkingDirectory = cfg.stateDir;
          StateDirectory = "zotero-selfhost/minio";
          ExecStartPre = pkgs.writeShellScript "zotero-selfhost-minio-prepare" ''
            set -euo pipefail
            mkdir -p ${cfg.stateDir}/minio-data
          '';
          ExecStart = pkgs.writeShellScript "zotero-selfhost-minio-start" ''
            set -euo pipefail
            export MINIO_ROOT_USER="$(tr -d '\n' < ${escapeShellArg (secretPath secretKeys.s3AccessKey)})"
            export MINIO_ROOT_PASSWORD="$(tr -d '\n' < ${escapeShellArg (secretPath secretKeys.s3SecretKey)})"
            exec ${pkgs.minio}/bin/minio server ${lib.escapeShellArg (cfg.stateDir + "/minio-data")} \
              --address 127.0.0.1:${toString cfg.infrastructure.minioPort} \
              --console-address 127.0.0.1:${toString cfg.infrastructure.minioConsolePort}
          '';
          Restart = "always";
          RestartSec = 5;
        };
      };

      services.nginx = {
        enable = true;
        recommendedProxySettings = true;
        # Note: TLS settings are intentionally not set here. They are a host-wide
        # concern; users should configure recommendedTlsSettings themselves if
        # their nginx build supports the required directives.
        virtualHosts.${cfg.infrastructure.hostname} = lib.mkMerge [
          {
            enableACME = cfg.infrastructure.enableACME;
            forceSSL = cfg.infrastructure.forceSSL;
            locations."/" = mkIf (!cfg.webLibrary.enable) {
              proxyPass = "http://${cfg.listenAddress}:${toString cfg.listenPort}";
            };
            locations."/stream/" = {
              proxyPass = "http://${cfg.listenAddress}:${toString cfg.streamPort}/";
              proxyWebsockets = true;
            };
          }
          # Web library SPA layout: serve the SPA at root and carve out
          # explicit dataserver API path prefixes via a regex location
          # that takes precedence over the SPA root in nginx evaluation
          # order. The SPA's React Router uses root-relative paths
          # (/<userSlug>/items/<key>/reader, etc) so it MUST live at
          # root or internal navigation breaks on refresh. The bundled
          # apiKey is gated behind basicAuthFile if set.
          (mkIf cfg.webLibrary.enable {
            locations = {
              # Dataserver API — open access (Zotero clients use the
              # Zotero-API-Key header). Regex prefix takes precedence
              # over the SPA root location.
              "~ ^/(users|groups|itemTypes|itemFields|creatorFields|itemTypeFields|itemTypeCreatorTypes|keys|login|storagepurge|test|tts|items|globalitems)(/|$)" = {
                proxyPass = "http://${cfg.listenAddress}:${toString cfg.listenPort}";
                extraConfig = ''
                  proxy_set_header Host $host;
                  proxy_set_header X-Real-IP $remote_addr;
                  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                  proxy_set_header X-Forwarded-Proto $scheme;
                '';
              };

              # /retractions/list — hosted-zotero.org-only endpoint that
              # the desktop client polls on every sync. Upstream
              # zotero/dataserver doesn't implement it, so on a self-host
              # the request falls through to the SPA root and trips the
              # basic-auth gate, surfacing as a noisy
              # "401 Authorization Required" in the client log on every
              # sync. Stub it: return an empty list with no auth, no
              # proxy. The client treats "no retractions" as the normal
              # case and stops complaining.
              "= /retractions/list" = {
                extraConfig = ''
                  auth_basic off;
                  default_type application/json;
                  return 200 '[]';
                '';
              };

              # SPA static assets — index.html references these as
              # /static/web-library/... (root-relative).
              "/static/web-library/" = {
                alias = "${webLibraryPkg}/static/web-library/";
              } // (lib.optionalAttrs (cfg.webLibrary.basicAuthFile != null) {
                basicAuthFile = cfg.webLibrary.basicAuthFile;
              });

              # SPA root catch-all with try_files fallback to index.html
              # for client-side routes. mkForce because the upstream
              # block above sets locations."/" to proxy_pass the
              # dataserver — when webLibrary.enable is true we replace
              # it entirely.
              "/" = lib.mkForce ({
                root = "${webLibraryPkg}";
                tryFiles = "$uri $uri/ /index.html";
              } // (lib.optionalAttrs (cfg.webLibrary.basicAuthFile != null) {
                basicAuthFile = cfg.webLibrary.basicAuthFile;
              }));
            };
          })
        ];
        virtualHosts.${cfg.infrastructure.attachmentsHostname} = {
          enableACME = cfg.infrastructure.enableACME;
          forceSSL = cfg.infrastructure.forceSSL;
          # nginx defaults client_max_body_size to 1m, which silently kills
          # any attachment upload over that size — Zotero PDFs are routinely
          # 10–100 MB. Raise the cap on this vhost specifically so the
          # presigned-URL POST flow has room to deliver the file body.
          extraConfig = ''
            client_max_body_size ${cfg.infrastructure.attachmentMaxBodySize};
          '';
          locations."/" = {
            # When the bundled minio is disabled, follow whatever endpointUrl
            # the operator configured (existing minio, AWS S3, R2, etc).
            # Otherwise short-circuit to the loopback bundled instance to
            # avoid the host vs. cfg.s3.endpointUrl drift.
            proxyPass =
              if cfg.infrastructure.minio.enable
              then "http://127.0.0.1:${toString cfg.infrastructure.minioPort}"
              else cfg.s3.endpointUrl;
          };
        };
      };
    })
  ]);
}
