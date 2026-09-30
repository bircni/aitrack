import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, ['--build-sea', 'sea-config.json'], { stdio: 'inherit' });

// Modifying the Node binary invalidates its signature; macOS requires a new one to run it.
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', 'dist-sidecar/opentrack-sidecar.exe'], {
    stdio: 'inherit',
  });
}
