const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');

const { sendNotification } = require('../src/services/notifications');

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('Notification Webhooks', () => {
  it('should group files from the same batch into a single webhook payload', async () => {
    const webhookCalls = [];

    global.fetch = async (url, options) => {
      webhookCalls.push({
        url,
        body: JSON.parse(options.body),
      });

      return {
        ok: true,
      };
    };

    const config = {
      appriseUrl: null,
      appriseMessage: 'New file uploaded - {filename} ({size}), Storage used {storage}',
      appriseSizeUnit: null,
      notificationWebhookUrl: 'https://example.test/webhook',
      notificationWebhookBearerToken: null,
      notificationBatchDelayMs: 10,
      uploadDir: './local_uploads',
      siteTitle: 'File Upload',
      baseUrl: 'https://upload.example.com/',
    };

    await sendNotification(
      {
        uploadId: 'upload-a',
        batchId: 'batch-1',
        filename: 'folder/a.txt',
        fileSize: 100,
        storedPath: 'folder/a.txt',
        completedAt: Date.now(),
      },
      config,
    );
    await sendNotification(
      {
        uploadId: 'upload-b',
        batchId: 'batch-1',
        filename: 'folder/b.txt',
        fileSize: 200,
        storedPath: 'folder/b.txt',
        completedAt: Date.now() + 1,
      },
      config,
    );

    await new Promise(resolve => setTimeout(resolve, 30));

    assert.strictEqual(webhookCalls.length, 1);
    assert.strictEqual(webhookCalls[0].url, 'https://example.test/webhook');
    assert.strictEqual(webhookCalls[0].body.batchId, 'batch-1');
    assert.strictEqual(webhookCalls[0].body.fileCount, 2);
    assert.strictEqual(webhookCalls[0].body.batchTotalSize, 300);
    assert.strictEqual(webhookCalls[0].body.files.length, 2);
    assert.deepStrictEqual(
      webhookCalls[0].body.files.map(file => file.storedPath),
      ['folder/a.txt', 'folder/b.txt'],
    );
  });
});
