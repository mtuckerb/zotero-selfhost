<?php
/**
 * Exercise the packaged PHP serializer with an in-memory attachment, cache,
 * and diagnostic database. No running services or credentials are used.
 * Run: php -d auto_prepend_file= tests/item-response-cache.php DATASERVER_DIR
 * Requires pdo_sqlite. Both toJSON() and toResponseJSON() are the real methods.
 */
class Zotero_DataObject {
    protected $loaded = ['primaryData' => true, 'itemData' => true];
    protected $_id = 1, $_key = 'TEST1234', $_version = 1;
    public function getDeleted() { return false; }
    public function getRelations() { return new stdClass; }
}
class Zotero_Permissions {}
class Z_CONFIG { public static $CACHE_ENABLED_ITEM_RESPONSE_JSON = true; }
class Z_Core {
    public static $MC;
    public static $compare = false;
    public static function probability($percent) { return self::$compare; }
}
class FixtureCache {
    public $entries = [];
    public function get($key) {
        return isset($this->entries[$key]) ? unserialize($this->entries[$key]) : false;
    }
    public function set($key, $value, $ttl = null) {
        $this->entries[$key] = serialize($value);
    }
}
class Z_Array {
    public static function filterKeys($values, $keys) {
        return array_intersect_key($values, array_flip($keys));
    }
}
class StatsD { public static function __callStatic($name, $args) {} }
class Zotero_Libraries {
    public static function getType($id) { return 'user'; }
    public static function toJSON($id) { return ['id' => $id, 'type' => 'user']; }
}
class Zotero_Shards { public static function getByLibraryID($id) { return 1; } }
class Zotero_API {
    public static function getItemURI($item) { return 'https://example.test/users/1/items/TEST1234'; }
}
class Zotero_URI extends Zotero_API {}
class Zotero_ItemTypes { public static function getName($id) { return 'attachment'; } }
class Zotero_Date { public static function sqlToISO8601($value) { return $value; } }
class Zotero_Utilities {
    public static function formatJSON($value) { return json_encode($value, JSON_PRETTY_PRINT); }
}
class Zotero_DB {
    public static $db;
    public static $tagReads = 0;
    public static function getShardHost($id) { return 'fixture'; }
    public static function isReadOnly($id) { return false; }
    public static function transactionInProgress() { return false; }
    public static function isReadSnapshotActive() { return false; }
    public static function query($sql, $id, $shard) {
        if (str_contains($sql, 'FROM itemTags')) { self::$tagReads++; }
        $statement = self::$db->prepare($sql);
        $statement->execute([$id]);
        return $statement->fetchAll(PDO::FETCH_ASSOC);
    }
    public static function valueQuery($sql, $id, $shard) {
        return array_values(self::query($sql, $id, $shard)[0])[0];
    }
    public static function rowQuery($sql, $id, $shard) {
        return self::query($sql, $id, $shard)[0] ?? false;
    }
}

require $argv[1] . '/model/Schema.inc.php';
require $argv[1] . '/model/Item.inc.php';
// As in the pinned source, 41 and 42 resolve to the current schema because
// the last archived schema is 40. Keep the real getEffectiveVersion() method.
(new ReflectionProperty(Zotero\Schema::class, 'version'))->setValue(null, 44);
(new ReflectionProperty(Zotero\Schema::class, 'knownVersions'))->setValue(null, [32, 33, 39, 40]);

class FixtureAttachment extends Zotero_Item {
    public function __construct() {
        (new ReflectionProperty(Zotero_Item::class, 'inPublications'))->setValue($this, false);
    }
    public function __get($field) {
        return [
            'id' => 1, 'key' => 'TEST1234', 'version' => 1, 'libraryID' => 1,
            'itemTypeID' => 14, 'attachmentLinkMode' => 'linked_url',
            'attachmentMIMEType' => 'application/pdf', 'attachmentCharset' => '',
            'attachmentLastRead' => 1788187126,
            'dateAdded' => '2026-09-01T00:00:00Z', 'dateModified' => '2026-09-01T00:00:00Z',
        ][$field];
    }
    public function getSource() { return false; }
    public function getSourceKey() { return false; }
    public function isRegularItem() { return false; }
    public function isNote() { return false; }
    public function isAnnotation() { return false; }
    public function isAttachment() { return true; }
    public function isPDFAttachment() { return true; }
    public function isStoredFileAttachment() { return false; }
    public function isEmbeddedImageAttachment() { return false; }
    public function getNote($sanitized=false, $htmlspecialchars=false) { return ''; }
    public function getTags($asIDs=false) { return []; }
    public function getCollections($asKeys=false) { return []; }
    public function getUncachedResponseProps($params, Zotero_Permissions $permissions) {
        return ['bestAttachmentDetails' => false, 'downloadDetails' => false, 'numChildren' => 0];
    }
}

Zotero_DB::$db = new PDO('sqlite::memory:');
Zotero_DB::$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
// Relevant columns from upstream misc/shard.sql: tag type belongs to tags.
Zotero_DB::$db->exec('CREATE TABLE items (itemID INTEGER, version INTEGER);
    INSERT INTO items VALUES (1, 1);
    CREATE TABLE itemAttachments (itemID INTEGER, storageHash TEXT, storageModTime INTEGER);
    CREATE TABLE itemCreators (itemID INTEGER, creatorID INTEGER, creatorTypeID INTEGER, orderIndex INTEGER);
    CREATE TABLE itemData (itemID INTEGER, fieldID INTEGER, value TEXT);
    CREATE TABLE tags (tagID INTEGER, name TEXT, type INTEGER);
    CREATE TABLE itemTags (itemID INTEGER, tagID INTEGER);
    INSERT INTO tags VALUES (1, "fixture", 1);
    INSERT INTO itemTags VALUES (1, 1);');

function check($condition, $message) {
    if (!$condition) { throw new RuntimeException($message); }
}
function response($schema) {
    return (new FixtureAttachment)->toResponseJSON([
        'v' => 3, 'schemaVersion' => $schema, 'publications' => false, 'include' => ['data']
    ], new Zotero_Permissions);
}

$failures = 0;
foreach ([false, true] as $compare) {
    foreach ([[42, 41, null, 41, 42], [41, 42, 41, null, 42]] as $versions) {
        Z_Core::$MC = new FixtureCache;
        Z_Core::$compare = $compare;
        try {
            foreach ($versions as $version) {
                $json = response($version);
                check(isset($json['data']['lastRead']) === ($version === null || $version >= 42),
                    'Attachment lastRead visibility crossed client schema versions');
            }
            print 'PASS mixed client schemas (comparison=' . (int)$compare . ', first=' . $versions[0] . ")\n";
        }
        catch (Throwable $e) {
            print 'FAIL ' . $e->getMessage() . "\n";
            $failures++;
        }
    }
}

// A genuine stale entry should be repaired, including its diagnostic reads.
Z_Core::$MC = new FixtureCache;
Z_Core::$compare = true;
$fresh = response(42);
$key = array_key_first(Z_Core::$MC->entries);
$stale = Z_Core::$MC->get($key);
$stale['data']['lastRead']--;
Z_Core::$MC->set($key, $stale);
try {
    $readsBefore = Zotero_DB::$tagReads;
    check(response(42) == $fresh, 'Cache mismatch did not return fresh data');
    check(Zotero_DB::$tagReads > $readsBefore, 'Diagnostic tag query was not exercised');
    check(Z_Core::$MC->get($key)['data'] == $fresh['data'], 'Stale cache was not repaired');
    print "PASS stale cache diagnostics and repair\n";
}
catch (Throwable $e) {
    print 'FAIL ' . $e->getMessage() . "\n";
    $failures++;
}
exit($failures ? 1 : 0);
