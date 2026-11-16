// Unit and offline tests for ZCode Bridge Adapter
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  readTask,
  findZCodePaths,
  readProviderConfig,
  listAvailableModels,
  runZCodePrompt,
  DEFAULT_MODEL,
  DEFAULT_THINKING,
  DEFAULT_PROVIDER
} from './dispatch-zcode.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('Running ZCode Bridge Adapter tests...\n');

  // Test 1: parseArgs defaults
  {
    const o = parseArgs(['--status']);
    assert.equal(o.status, true);
    assert.equal(o.model, DEFAULT_MODEL);
    assert.equal(o.thinking, DEFAULT_THINKING);
    assert.equal(o.provider, DEFAULT_PROVIDER);
    assert.equal(o.mode, 'yolo');
    console.log('[PASS] Test 1: parseArgs defaults verified');
  }

  // Test 2: parseArgs rejects invalid options & conflicts
  {
    assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
    assert.throws(() => parseArgs(['--status', '--models']), /separate read-only commands/);
    assert.throws(() => parseArgs(['--file', 'a.md', '--prompt', 'hi']), /cannot be used simultaneously/);
    assert.throws(() => parseArgs(['--thinking', 'invalid']), /Invalid --thinking level/);
    console.log('[PASS] Test 2: parseArgs validation & conflict rules verified');
  }

  // Test 3: readTask UTF-8 & size limits
  {
    const tmpFile = path.join(__dirname, 'test-task.tmp.md');
    fs.writeFileSync(tmpFile, '# Task\n\n请回复：ZCode桥接已收到！\n', 'utf8');
    const task = readTask(tmpFile);
    assert.equal(typeof task.sha256, 'string');
    assert.equal(task.sha256.length, 64);
    assert.match(task.text, /ZCode桥接已收到！/);
    fs.unlinkSync(tmpFile);
    console.log('[PASS] Test 3: readTask UTF-8 decode & SHA-256 verified');
  }

  // Test 4: findZCodePaths locates <ZCODE_INSTALL_DIR> installation
  {
    const paths = findZCodePaths();
    assert.ok(fs.existsSync(paths.rootDir), 'ZCode root exists');
    assert.ok(fs.existsSync(paths.cliPath), 'ZCode cliPath exists');
    assert.ok(fs.existsSync(paths.patchPath), 'Preload patch exists');
    console.log('[PASS] Test 4: findZCodePaths successfully located ZCode');
  }

  // Test 5: readProviderConfig and listAvailableModels
  {
    const paths = findZCodePaths();
    const models = listAvailableModels(paths.configPath);
    assert.ok(models.length > 0, 'Configured models found');
    const glm53 = models.find(m => m.modelId === 'GLM-5.3-Flash');
    assert.ok(glm53, 'GLM-5.3-Flash is in model list');
    assert.equal(glm53.supportsThinking, true, 'GLM-5.3-Flash supports thinking');
    assert.equal(glm53.recommendedThinking, 'high', 'Recommended thinking is high');
    console.log('[PASS] Test 5: Model registry & thinking options verified');
  }

  // Test 6: Dry-run verification
  {
    const tmpFile = path.join(__dirname, 'test-dry-run.tmp.md');
    fs.writeFileSync(tmpFile, 'ZCode桥接已收到！', 'utf8');
    const task = readTask(tmpFile);
    const opts = parseArgs([
      '--file', tmpFile,
      '--dry-run',
      '--model', 'GLM-5.3-Flash',
      '--thinking', 'high',
      '--provider', 'zai-standard-api'
    ]);
    opts.task = task;
    const res = await runZCodePrompt(opts);
    assert.equal(res.dryRun, true);
    assert.equal(res.status, 'verified');
    fs.unlinkSync(tmpFile);
    console.log('[PASS] Test 6: Dry-run execution plan verified');
  }

  console.log('\nAll 6 tests passed successfully!');
}

runTests().catch(err => {
  console.error('\nTest failed:', err);
  process.exit(1);
});
