import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'codex-sdk-contract-'));
const environment = { ...process.env, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, OPENAI_BASE_URL: undefined,
  PYTHONPATH: undefined, PYTHONHOME: undefined, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', CODEX_HOME: path.join(temporary, 'codex-home'),
  CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(temporary, 'runtimes') };
const run = (command, args, extra = {}) => execFileSync(command, args, { cwd: root, env: environment, stdio: 'inherit', ...extra });
try {
  let python = process.env.CODEX_MCP_BRIDGE_SDK_TEST_PYTHON;
  if (!python) {
    run(process.env.CODEX_MCP_BRIDGE_TEST_PYTHON || 'python3', ['-I', '-m', 'venv', path.join(temporary, 'python')]);
    python = path.join(temporary, 'python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    run(python, ['-s', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-cache-dir', '--require-hashes', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '-r', 'sdk/requirements.lock']);
  }
  environment.CODEX_MCP_BRIDGE_SDK_TEST_PYTHON = python;
  run(python, ['-s', 'test/sdk-worker.test.py']);
  run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/sdkUpstream.contract.test.ts', '--maxWorkers=1']);
} finally { rmSync(temporary, { recursive: true, force: true }); }
