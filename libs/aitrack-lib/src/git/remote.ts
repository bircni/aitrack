import { cloneOriginUrl, isCloned } from '../git.js';

/** An HTTPS remote can hold a token, and this output gets pasted into bug reports. An SSH user name is no secret. */
export function redactUrl(url: string): string {
  return url.replace(
    /^([a-z][a-z\d+.-]*:\/\/)([^/?#]*)@/iu,
    (whole, scheme: string, userinfo: string) =>
      scheme.toLowerCase() === 'ssh://' && !userinfo.includes(':') ? whole : `${scheme}***@`,
  );
}

interface RemoteIdentity {
  host: string; // Empty for a local path.
  path: string;
  transport: string;
  port: string;
}

const TRANSPORTS: Readonly<Record<string, { name: string; defaultPort: string }>> = {
  ssh: { name: 'ssh', defaultPort: '22' },
  'git+ssh': { name: 'ssh', defaultPort: '22' },
  http: { name: 'http', defaultPort: '80' },
  https: { name: 'http', defaultPort: '443' },
  git: { name: 'git', defaultPort: '9418' },
};

function repoPath(path: string): string {
  return path.replace(/\/+$/u, '').replace(/\.git$/u, '');
}

function remoteIdentity(url: string): RemoteIdentity {
  const full =
    /^([a-z][a-z\d+.-]*):\/\/(?:[^/?#]*@)?(\[[^\]]*\]|[^/:?#]*)(?::(\d+))?(\/.*)?$/iu.exec(url);
  const transport = full && TRANSPORTS[full[1]?.toLowerCase() ?? ''];
  if (full && transport) {
    return {
      host: full[2]?.toLowerCase() ?? '',
      path: repoPath(full[4] ?? '').replace(/^\/+/u, ''),
      transport: transport.name,
      port: full[3] === transport.defaultPort ? '' : (full[3] ?? ''),
    };
  }
  if (full?.[1]?.toLowerCase() === 'file') {
    return { host: '', path: repoPath(full[4] ?? ''), transport: 'file', port: '' };
  }
  // Scp form, as git reads it: a colon before any slash. One letter is a Windows drive.
  const scp = /^(?:[^/@:]+@)?(\[[^\]]+\]|[^/:@]{2,}):(.*)$/u.exec(url);
  if (scp && !full) {
    return {
      host: scp[1]?.toLowerCase() ?? '',
      path: repoPath(scp[2] ?? '').replace(/^\/+/u, ''),
      transport: 'ssh',
      port: '',
    };
  }
  return { host: '', path: repoPath(url), transport: 'file', port: '' };
}

/**
 * Whether two URLs name one repository, however each is written. A port only tells two servers apart
 * over one transport: a host's SSH and HTTPS ports differ anyway.
 */
export function sameRemote(a: string, b: string): boolean {
  if (a === b) return true;
  const [left, right] = [remoteIdentity(a), remoteIdentity(b)];
  return (
    left.host === right.host &&
    left.path === right.path &&
    (left.transport !== right.transport || left.port === right.port)
  );
}

/** The clone's origin when it is not `url`; null with no clone, one whose origin cannot be read, or an empty url, which claims no remote. */
export function differingOrigin(url: string): string | null {
  if (url === '' || !isCloned()) return null;
  const origin = cloneOriginUrl();
  return origin !== null && !sameRemote(origin, url) ? origin : null;
}

export function originMismatchMessage(origin: string, repoUrl: string): string {
  return (
    `The local clone pushes to ${redactUrl(origin)}, but repoUrl is ${redactUrl(repoUrl)}. ` +
    `To move to repoUrl, run: aitrack init --repo <url> (replaces the clone after asking). ` +
    `To stay on the clone's remote, run: aitrack config set repoUrl <url>.`
  );
}
