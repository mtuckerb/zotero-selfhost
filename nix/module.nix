{ config, lib, pkgs, ... }:

let
  cfg = config.services.zotero-selfhost;
  inherit (lib) mkDefault mkEnableOption mkIf mkMerge mkOption optionalString types escapeShellArg nameValuePair mapAttrs';

  php = pkgs.php82.buildEnv {
    extensions = ({ enabled, all }: enabled ++ (with all; [ curl intl mbstring mysqli redis memcached ]));
    extraConfig = ''
      memory_limit = 1G
      max_execution_time = 300
      short_open_tag = On
      display_errors = Off
      error_reporting = E_ALL & ~E_NOTICE & ~E_STRICT & ~E_DEPRECATED
    '';
  };

  streamServerPkg = pkgs.stdenvNoCC.mkDerivation {
    pname = "zotero-selfhost-stream-server";
    version = "git";
    src = cfg.streamServerSrc;
    nativeBuildInputs = [ pkgs.makeWrapper pkgs.nodejs pkgs.npm ];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/libexec/stream-server
      cp -R . $out/libexec/stream-server/
      chmod -R u+w $out/libexec/stream-server
      rm -rf $out/libexec/stream-server/node_modules
      HOME=$TMPDIR npm_config_cache=$TMPDIR/npm-cache npm ci --omit=dev --prefix $out/libexec/stream-server
      makeWrapper ${pkgs.nodejs}/bin/node $out/bin/zotero-stream-server \
        --chdir $out/libexec/stream-server \
        --add-flags index.js
      runHook postInstall
    '';
  };

  tinymceCleanServerPkg = pkgs.stdenvNoCC.mkDerivation {
    pname = "zotero-selfhost-tinymce-clean-server";
    version = "git";
    src = cfg.tinymceCleanServerSrc;
    nativeBuildInputs = [ pkgs.makeWrapper pkgs.nodejs pkgs.npm ];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/libexec/tinymce-clean-server
      cp -R . $out/libexec/tinymce-clean-server/
      chmod -R u+w $out/libexec/tinymce-clean-server
      rm -rf $out/libexec/tinymce-clean-server/node_modules
      HOME=$TMPDIR npm_config_cache=$TMPDIR/npm-cache npm install --omit=dev --prefix $out/libexec/tinymce-clean-server
      makeWrapper ${pkgs.nodejs}/bin/node $out/bin/zotero-tinymce-clean-server \
        --chdir $out/libexec/tinymce-clean-server \
        --add-flags server.js
      runHook postInstall
    '';
  };

  dataserverPkg = pkgs.stdenvNoCC.mkDerivation {
    pname = "zotero-selfhost-dataserver";
    version = "git";
    src = cfg.dataserverSrc;
    nativeBuildInputs = [ pkgs.php82Packages.composer pkgs.rsync ];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/zotero-dataserver
      rsync -a --exclude .git --exclude tests --exclude tmp --exclude vendor ./ $out/share/zotero-dataserver/
      chmod -R u+w $out/share/zotero-dataserver
      export HOME=$TMPDIR
      export COMPOSER_HOME=$TMPDIR/composer
      export COMPOSER_CACHE_DIR=$TMPDIR/composer-cache
      cd $out/share/zotero-dataserver
      composer install --no-dev --no-interaction --no-progress --optimize-autoloader
      runHook postInstall
    '';
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

      export MYSQL_PWD="$(read_secret ${escapeShellArg (secretPath secretKeys.mysqlPassword)})"
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

      echo "SET @@global.innodb_large_prefix = 1;" | mysql_base
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
      echo "INSERT INTO libraries VALUES (1, 'user', CURRENT_TIMESTAMP, 0, 1)" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO libraries VALUES (2, 'group', CURRENT_TIMESTAMP, 0, 2)" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO users VALUES (1, 1, '$superuser_name_sql', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO groups VALUES (1, 2, 'Shared', 'shared', 'Private', 'members', 'all', 'members', \"\", \"\", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO groupUsers VALUES (1, 1, 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)" | mysql_base ${cfg.mysql.masterDb}

      mysql_base ${cfg.mysql.wwwDb} < ${cfg.wwwSql}
      echo "INSERT INTO users VALUES (1, '$superuser_name_sql', MD5('$superuser_password_sql'), 'normal')" | mysql_base ${cfg.mysql.wwwDb}
      echo "INSERT INTO users_email (userID, email) VALUES (1, '$superuser_email_sql')" | mysql_base ${cfg.mysql.wwwDb}
      echo "INSERT INTO storage_institutions (institutionID, domain, storageQuota) VALUES (1, 'zotero.org', 10000)" | mysql_base ${cfg.mysql.wwwDb}
      echo "INSERT INTO storage_institution_email (institutionID, email) VALUES (1, 'contact@zotero.org')" | mysql_base ${cfg.mysql.wwwDb}

      for shard in ${cfg.mysql.shardDb} zotero_shard_2; do
        mysql_base "$shard" < "$misc/shard.sql"
        mysql_base "$shard" < "$misc/triggers.sql"
      done
      echo "INSERT INTO shardLibraries VALUES (1, 'user', CURRENT_TIMESTAMP, 0)" | mysql_base ${cfg.mysql.shardDb}
      echo "INSERT INTO shardLibraries VALUES (2, 'group', CURRENT_TIMESTAMP, 0)" | mysql_base zotero_shard_2
      mysql_base ${cfg.mysql.idsDb} < "$misc/ids.sql"

      ${optionalString (cfg.s3.createBuckets && cfg.s3.endpointUrl != null) ''
        export AWS_ACCESS_KEY_ID="$(read_secret ${escapeShellArg (secretPath secretKeys.s3AccessKey)})"
        export AWS_SECRET_ACCESS_KEY="$(read_secret ${escapeShellArg (secretPath secretKeys.s3SecretKey)})"
        export AWS_DEFAULT_REGION=${lib.escapeShellArg cfg.s3.region}
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

      export MYSQL_PWD="$(read_secret ${escapeShellArg (secretPath secretKeys.mysqlPassword)})"
      MYSQL_HOST=${lib.escapeShellArg cfg.mysql.host}
      MYSQL_PORT=${toString cfg.mysql.port}
      MYSQL_USER=${lib.escapeShellArg cfg.mysql.user}
      username_sql="$(sql_escape "$username")"
      password_sql="$(sql_escape "$password")"
      email_sql="$(sql_escape "$email")"

      mysql_base() {
        mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" "$@"
      }

      echo "INSERT INTO libraries VALUES ($uid, 'user', CURRENT_TIMESTAMP, 0, 1)" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO users VALUES ($uid, $uid, '$username_sql', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO groupUsers VALUES (1, $uid, 'member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)" | mysql_base ${cfg.mysql.masterDb}
      echo "INSERT INTO users VALUES ($uid, '$username_sql', MD5('$password_sql'))" | mysql_base ${cfg.mysql.wwwDb}
      echo "INSERT INTO users_email (userID, email) VALUES ($uid, '$email_sql')" | mysql_base ${cfg.mysql.wwwDb}
      echo "INSERT INTO shardLibraries VALUES ($uid, 'user', 0, 0)" | mysql_base ${cfg.mysql.shardDb}
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
      default = ../src/server/dataserver;
      description = "Path to the Zotero dataserver checkout.";
    };

    streamServerSrc = mkOption {
      type = types.path;
      default = ../src/server/stream-server;
      description = "Path to the Zotero stream-server checkout.";
    };

    tinymceCleanServerSrc = mkOption {
      type = types.path;
      default = ../src/server/tinymce-clean-server;
      description = "Path to the Zotero tinymce-clean-server checkout.";
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
        ExecStart = "${pkgs.nodejs}/bin/node ${streamRuntime}/index.js";
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
        ExecStart = "${pkgs.nodejs}/bin/node ${tinymceRuntime}/server.js";
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
      ++ lib.optionals cfg.infrastructure.enable [
        "mysql.service"
        "redis-zotero-selfhost.service"
        "memcached.service"
        "opensearch.service"
        "zotero-selfhost-minio.service"
      ];
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

      systemd.services.zotero-selfhost-minio = {
        description = "Zotero Selfhost MinIO object storage";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
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
        recommendedTlsSettings = true;
        virtualHosts.${cfg.infrastructure.hostname} = {
          enableACME = cfg.infrastructure.enableACME;
          forceSSL = cfg.infrastructure.forceSSL;
          locations."/" = {
            proxyPass = "http://${cfg.listenAddress}:${toString cfg.listenPort}";
          };
          locations."/stream/" = {
            proxyPass = "http://${cfg.listenAddress}:${toString cfg.streamPort}/";
            proxyWebsockets = true;
          };
        };
        virtualHosts.${cfg.infrastructure.attachmentsHostname} = {
          enableACME = cfg.infrastructure.enableACME;
          forceSSL = cfg.infrastructure.forceSSL;
          locations."/" = {
            proxyPass = "http://127.0.0.1:${toString cfg.infrastructure.minioPort}";
          };
        };
      };
    })
  ]);
}
