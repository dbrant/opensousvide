// Stops Metro dev servers (`expo start`) started from this project, and
// nothing else: a process must be Node running this project's own Expo CLI.
//
//   npm run stop-metro                      stop all of them
//   npm run stop-metro -- --port 8082       stop only the one on that port
//   npm run stop-metro -- --dry-run         list matches without stopping them

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? args[portIndex + 1] : undefined;
if (portIndex >= 0 && !/^\d+$/.test(port ?? '')) {
  console.error('Usage: stop-metro [--port <number>] [--dry-run]');
  process.exit(2);
}

const normalize = (s) => s.replace(/[\\/]+/g, '/').toLowerCase();
const expoCli = normalize(`${projectDir}/node_modules/`);

function listNodeProcesses() {
  if (process.platform === 'win32') {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      'Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
      pid: p.ProcessId,
      commandLine: p.CommandLine ?? '',
    }));
  }
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, commandLine]) => ({ pid: Number(pid), commandLine }));
}

function isProjectMetro(commandLine) {
  const cmd = normalize(commandLine);
  if (!cmd.includes(expoCli) || !cmd.includes('/expo/bin/cli') || !/\sstart(\s|$)/.test(cmd)) return false;
  if (port === undefined) return true;
  const match = cmd.match(/--port[=\s]+(\d+)/);
  return (match ? match[1] : '8081') === port;
}

function stop(pid) {
  if (process.platform === 'win32') {
    // /T also stops Metro's worker processes.
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

const matches = listNodeProcesses().filter((p) => p.pid !== process.pid && isProjectMetro(p.commandLine));
if (matches.length === 0) {
  console.log(port ? `No Metro server from this project is running on port ${port}.` : 'No Metro server from this project is running.');
  process.exit(0);
}

let failed = false;
for (const { pid, commandLine } of matches) {
  const where = commandLine.match(/--port[=\s]+(\d+)/)?.[1] ?? '8081';
  if (dryRun) {
    console.log(`Would stop Metro on port ${where} (PID ${pid})`);
    continue;
  }
  try {
    stop(pid);
    console.log(`Stopped Metro on port ${where} (PID ${pid})`);
  } catch (e) {
    failed = true;
    console.error(`Could not stop PID ${pid}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
