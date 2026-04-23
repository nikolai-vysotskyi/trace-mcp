import { describe, it, expect, beforeEach } from 'vitest';
import { PhpEcosystemPlugin } from '../../../src/indexer/plugins/integration/tooling/php-ecosystem/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function ctxWithRequire(require: Record<string, string>): ProjectContext {
  return {
    rootPath: '/tmp/nonexistent-trace-mcp-fixture-php',
    composerJson: { require },
    configFiles: [],
  };
}

describe('PhpEcosystemPlugin', () => {
  let plugin: PhpEcosystemPlugin;

  beforeEach(() => {
    plugin = new PhpEcosystemPlugin();
  });

  describe('detect()', () => {
    it('detects google/apiclient', () => {
      expect(plugin.detect(ctxWithRequire({ 'google/apiclient': '^2.0' }))).toBe(true);
    });

    it('detects laravel/ai', () => {
      expect(plugin.detect(ctxWithRequire({ 'laravel/ai': '^1.0' }))).toBe(true);
    });

    it('detects echolabsdev/prism (laravel/ai predecessor)', () => {
      expect(plugin.detect(ctxWithRequire({ 'echolabsdev/prism': '^0.1' }))).toBe(true);
    });

    it('detects symfony/dom-crawler', () => {
      expect(plugin.detect(ctxWithRequire({ 'symfony/dom-crawler': '^6.0' }))).toBe(true);
    });

    it('detects doctrine/dbal', () => {
      expect(plugin.detect(ctxWithRequire({ 'doctrine/dbal': '^3.0' }))).toBe(true);
    });

    it('detects guzzlehttp/guzzle', () => {
      expect(plugin.detect(ctxWithRequire({ 'guzzlehttp/guzzle': '^7.0' }))).toBe(true);
    });

    it('detects maatwebsite/excel', () => {
      expect(plugin.detect(ctxWithRequire({ 'maatwebsite/excel': '^3.1' }))).toBe(true);
    });

    it('detects meilisearch/meilisearch-php', () => {
      expect(plugin.detect(ctxWithRequire({ 'meilisearch/meilisearch-php': '^1.5' }))).toBe(true);
    });

    it('detects google/analytics-data', () => {
      expect(plugin.detect(ctxWithRequire({ 'google/analytics-data': '^0.18' }))).toBe(true);
    });

    it('detects google/auth', () => {
      expect(plugin.detect(ctxWithRequire({ 'google/auth': '^1.0' }))).toBe(true);
    });

    it('detects intervention/image', () => {
      expect(plugin.detect(ctxWithRequire({ 'intervention/image': '^3.0' }))).toBe(true);
    });

    it('detects intervention/image-laravel', () => {
      expect(plugin.detect(ctxWithRequire({ 'intervention/image-laravel': '^1.0' }))).toBe(true);
    });

    it('detects league/csv', () => {
      expect(plugin.detect(ctxWithRequire({ 'league/csv': '^9.0' }))).toBe(true);
    });

    it('detects league/flysystem-aws-s3-v3', () => {
      expect(plugin.detect(ctxWithRequire({ 'league/flysystem-aws-s3-v3': '^3.0' }))).toBe(true);
    });

    it('detects amocrm/amocrm-api-library', () => {
      expect(plugin.detect(ctxWithRequire({ 'amocrm/amocrm-api-library': '^1.0' }))).toBe(true);
    });

    it('detects reinink/advanced-eloquent', () => {
      expect(plugin.detect(ctxWithRequire({ 'reinink/advanced-eloquent': '^1.0' }))).toBe(true);
    });

    it('detects spatie/laravel-translation-loader', () => {
      expect(plugin.detect(ctxWithRequire({ 'spatie/laravel-translation-loader': '^2.0' }))).toBe(true);
    });

    it('detects titasgailius/search-relations', () => {
      expect(plugin.detect(ctxWithRequire({ 'titasgailius/search-relations': '^2.0' }))).toBe(true);
    });

    it('detects yoomoney/yookassa-sdk-php', () => {
      expect(plugin.detect(ctxWithRequire({ 'yoomoney/yookassa-sdk-php': '^2.6' }))).toBe(true);
    });

    it('returns false when none of the tracked packages are present', () => {
      expect(plugin.detect(ctxWithRequire({ 'laravel/framework': '^11.0' }))).toBe(false);
    });
  });

  describe('extractNodes()', () => {
    beforeEach(() => {
      // enable the plugin so extractNodes actually inspects content
      plugin.detect(ctxWithRequire({ 'google/apiclient': '^2.0' }));
    });

    it('tags Google API client usage', () => {
      const source = Buffer.from(`<?php
use Google_Client;
$client = new Google_Client();`);
      const result = plugin.extractNodes('src/Services/Gmail.php', source, 'php');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().frameworkRole).toBe('google_api_client');
    });

    it('tags namespaced Google\\Client usage', () => {
      const source = Buffer.from(`<?php
use Google\\Client;
$client = new Google\\Client();`);
      const result = plugin.extractNodes('src/Services/Drive.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('google_api_client');
    });

    it('tags Laravel AI prompt calls', () => {
      const source = Buffer.from(`<?php
use Prism\\Prism\\Prism;
$response = Prism::text()->generate();`);
      const result = plugin.extractNodes('app/Services/Chat.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('laravel_ai_call');
    });

    it('tags Symfony DomCrawler usage', () => {
      const source = Buffer.from(`<?php
use Symfony\\Component\\DomCrawler\\Crawler;
$crawler = new Crawler($html);`);
      const result = plugin.extractNodes('src/Scraper.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('dom_crawler_usage');
    });

    it('tags Doctrine DBAL connection usage', () => {
      const source = Buffer.from(`<?php
use Doctrine\\DBAL\\DriverManager;
$conn = DriverManager::getConnection($params);
$qb = $conn->createQueryBuilder();`);
      const result = plugin.extractNodes('src/Repository/UserRepo.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('doctrine_dbal_usage');
    });

    it('tags Guzzle HTTP client usage', () => {
      const source = Buffer.from(`<?php
use GuzzleHttp\\Client;
$client = new Client(['base_uri' => 'https://api.example.com']);
$response = $client->request('GET', '/users');`);
      const result = plugin.extractNodes('src/Services/ApiClient.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('guzzle_http_client');
    });

    it('tags Laravel Excel import/export usage', () => {
      const source = Buffer.from(`<?php
use Maatwebsite\\Excel\\Facades\\Excel;
Excel::import(new UsersImport, 'users.xlsx');`);
      const result = plugin.extractNodes('app/Http/Controllers/UserController.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('maatwebsite_excel_usage');
    });

    it('tags Meilisearch client usage', () => {
      const source = Buffer.from(`<?php
use Meilisearch\\Client;
$client = new Client('http://127.0.0.1:7700', 'masterKey');
$client->index('movies')->search('star wars');`);
      const result = plugin.extractNodes('app/Services/Search.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('meilisearch_client');
    });

    it('tags Guzzle DI with FQN type hint (no use statement)', () => {
      const source = Buffer.from(`<?php
namespace App\\Services;
class ApiClient {
  public function __construct(private \\GuzzleHttp\\ClientInterface $http) {}
  public function fetch(): array {
    return json_decode($this->http->get('/users')->getBody()->getContents(), true);
  }
}`);
      const result = plugin.extractNodes('app/Services/ApiClient.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('guzzle_http_client');
    });

    it('tags Guzzle via RequestOptions reference', () => {
      const source = Buffer.from(`<?php
use GuzzleHttp\\RequestOptions;
$opts = [RequestOptions::JSON => ['foo' => 'bar']];`);
      const result = plugin.extractNodes('src/Util.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('guzzle_http_client');
    });

    it('tags DBAL via fetchAssociative without namespace import', () => {
      const source = Buffer.from(`<?php
class UserRepo {
  public function __construct(private $conn) {}
  public function findOne(int $id): ?array {
    return $this->conn->fetchAssociative('SELECT * FROM users WHERE id = ?', [$id]) ?: null;
  }
}`);
      const result = plugin.extractNodes('src/Repo/UserRepo.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('doctrine_dbal_usage');
    });

    it('tags DBAL via executeStatement on injected connection', () => {
      const source = Buffer.from(`<?php
use Doctrine\\DBAL\\Connection;
class Updater {
  public function __construct(private Connection $conn) {}
  public function bump(): void {
    $this->conn->executeStatement('UPDATE counters SET n = n + 1');
  }
}`);
      const result = plugin.extractNodes('src/Updater.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('doctrine_dbal_usage');
    });

    it('tags Meilisearch when call chain is split across lines', () => {
      const source = Buffer.from(`<?php
use Meilisearch\\Client;
class Search {
  public function __construct(private Client $client) {}
  public function find(string $q): array {
    $index = $this->client->index('movies');
    return $index->search($q)->getHits();
  }
}`);
      const result = plugin.extractNodes('app/Services/Search.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('meilisearch_client');
    });

    it('tags Meilisearch with pre-v1 MeiliSearch casing', () => {
      const source = Buffer.from(`<?php
use MeiliSearch\\Client;
$client = new Client($host, $key);`);
      const result = plugin.extractNodes('legacy/search.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('meilisearch_client');
    });

    it('tags Maatwebsite Excel export class (via Concerns import)', () => {
      const source = Buffer.from(`<?php
namespace App\\Exports;
use Maatwebsite\\Excel\\Concerns\\FromCollection;
use Maatwebsite\\Excel\\Concerns\\WithHeadings;
class UsersExport implements FromCollection, WithHeadings {
  public function collection() { return collect(); }
  public function headings(): array { return ['id', 'name']; }
}`);
      const result = plugin.extractNodes('app/Exports/UsersExport.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('maatwebsite_excel_usage');
    });

    it('tags Maatwebsite Excel via Excel::export facade call', () => {
      const source = Buffer.from(`<?php
class ReportController {
  public function download() {
    return Excel::export(new ReportExport, 'report.xlsx');
  }
}`);
      const result = plugin.extractNodes('app/Http/Controllers/ReportController.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('maatwebsite_excel_usage');
    });

    it('tags Google Analytics Data API usage', () => {
      const source = Buffer.from(`<?php
use Google\\Analytics\\Data\\V1beta\\BetaAnalyticsDataClient;
$client = new BetaAnalyticsDataClient();`);
      const result = plugin.extractNodes('app/Services/Analytics.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('google_analytics_data_usage');
    });

    it('tags Google Auth library usage', () => {
      const source = Buffer.from(`<?php
use Google\\Auth\\Credentials\\ServiceAccountCredentials;
$creds = new ServiceAccountCredentials($scopes, $jsonKey);`);
      const result = plugin.extractNodes('app/Auth/GoogleAuth.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('google_auth_usage');
    });

    it('does not confuse google/apiclient with google/analytics-data', () => {
      const source = Buffer.from(`<?php
use Google\\Analytics\\Data\\V1beta\\BetaAnalyticsDataClient;
// contains "DataClient" but should NOT be tagged as google_api_client
$x = new BetaAnalyticsDataClient();`);
      const result = plugin.extractNodes('src/AnalyticsWrapper.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('google_analytics_data_usage');
    });

    it('tags Intervention Image usage', () => {
      const source = Buffer.from(`<?php
use Intervention\\Image\\ImageManager;
$manager = ImageManager::gd();
$img = $manager->read('photo.jpg')->resize(800, 600)->save('out.jpg');`);
      const result = plugin.extractNodes('app/Services/ImageProcessor.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('intervention_image_usage');
    });

    it('tags Intervention Image Laravel facade usage', () => {
      // intervention/image-laravel exposes the Laravel facade resolving to the
      // same Intervention\Image\ImageManager — matches via the broad FQN.
      const source = Buffer.from(`<?php
use Intervention\\Image\\Laravel\\Facades\\Image;
$img = Image::read($path)->resize(800, 600);`);
      const result = plugin.extractNodes('app/Http/Controllers/UploadController.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('intervention_image_usage');
    });

    it('tags league/csv Reader usage', () => {
      const source = Buffer.from(`<?php
use League\\Csv\\Reader;
$reader = Reader::createFromPath('data.csv', 'r');
$reader->setHeaderOffset(0);`);
      const result = plugin.extractNodes('app/Imports/LeadsImport.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('league_csv_usage');
    });

    it('tags league/csv Writer usage via static constructor (no use statement)', () => {
      const source = Buffer.from(`<?php
namespace App\\Exports;
class LeadsExport {
  public function handle(): void {
    $writer = Writer::createFromString('');
    $writer->insertOne(['name', 'email']);
  }
}`);
      const result = plugin.extractNodes('app/Exports/LeadsExport.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('league_csv_usage');
    });

    it('tags Flysystem S3 adapter usage (via namespace)', () => {
      const source = Buffer.from(`<?php
use League\\Flysystem\\AwsS3V3\\AwsS3V3Adapter;
use Aws\\S3\\S3Client;
$adapter = new AwsS3V3Adapter(new S3Client($cfg), 'bucket');`);
      const result = plugin.extractNodes('config/filesystems.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('flysystem_s3_adapter_usage');
    });

    it('tags Flysystem S3 adapter via bare class name reference', () => {
      const source = Buffer.from(`<?php
// No use statement — reference via FQN-less adapter constant
class StorageFactory {
  public function make(): AwsS3V3Adapter { return new AwsS3V3Adapter(); }
}`);
      const result = plugin.extractNodes('src/StorageFactory.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('flysystem_s3_adapter_usage');
    });

    it('tags amoCRM API library usage', () => {
      const source = Buffer.from(`<?php
use AmoCRM\\Client\\AmoCRMApiClient;
$amo = new AmoCRMApiClient($clientId, $secret, $redirectUri);
$leads = $amo->leads()->get();`);
      const result = plugin.extractNodes('app/Integrations/Amo.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('amocrm_api_usage');
    });

    it('tags Reinink Advanced Eloquent usage', () => {
      const source = Buffer.from(`<?php
use Reinink\\AdvancedEloquent\\Model;
class User extends Model {}`);
      const result = plugin.extractNodes('app/Models/User.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('advanced_eloquent_usage');
    });

    it('tags Spatie translation loader usage', () => {
      const source = Buffer.from(`<?php
use Spatie\\TranslationLoader\\LanguageLine;
LanguageLine::create(['group' => 'auth', 'key' => 'failed', 'text' => ['en' => 'Bad credentials']]);`);
      const result = plugin.extractNodes('database/seeders/TranslationSeeder.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('spatie_translation_loader_usage');
    });

    it('tags Titasgailius search-relations trait usage', () => {
      const source = Buffer.from(`<?php
use Titasgailius\\SearchRelations\\SearchesRelations;
class Order extends Resource {
  use SearchesRelations;
  public static \$searchRelations = ['user' => ['name', 'email']];
}`);
      const result = plugin.extractNodes('app/Nova/Order.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('search_relations_usage');
    });

    it('tags YooKassa SDK usage', () => {
      const source = Buffer.from(`<?php
use YooKassa\\Client;
$client = new Client();
$client->setAuth($shopId, $secretKey);
$payment = $client->createPayment(['amount' => ['value' => '100.00', 'currency' => 'RUB']]);`);
      const result = plugin.extractNodes('app/Services/Payments.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBe('yookassa_usage');
    });

    it('does NOT false-match a bare ->get() call without Guzzle context', () => {
      const source = Buffer.from(`<?php
class Cache {
  public function __construct(private $store) {}
  public function read(string $k) {
    return $this->store->get($k);
  }
}`);
      const result = plugin.extractNodes('src/Cache.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBeUndefined();
    });

    it('ignores non-php languages', () => {
      const source = Buffer.from('const Google_Client = {};');
      const result = plugin.extractNodes('src/fake.ts', source, 'typescript');
      expect(result._unsafeUnwrap().frameworkRole).toBeUndefined();
    });

    it('leaves unrelated PHP files untouched', () => {
      const source = Buffer.from('<?php\nclass Plain {}');
      const result = plugin.extractNodes('src/Plain.php', source, 'php');
      expect(result._unsafeUnwrap().frameworkRole).toBeUndefined();
    });
  });
});
