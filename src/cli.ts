import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function bindingPage(args: string[]): string {
  const [command, option, url, oldOption, oldScope] = args;
  const legacyArgs = args.length === 5 && oldOption === '--scope' && (oldScope === 'read' || oldScope === 'write');
  if (command !== 'bind' || option !== '--url' || !url || (args.length !== 3 && !legacyArgs)) {
    throw new Error('Usage: codeharbor bind --url URL');
  }
  const parsed = URL.parse(url);
  const local = parsed && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (
    !parsed ||
    (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  ) {
    throw new Error('CodeHarbor URL must be an HTTPS origin without credentials, path, query or fragment');
  }
  return new URL('/ui/onboarding', parsed).href;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`请在浏览器打开以下页面，用飞书登录后绑定 PAT：\n${bindingPage(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid CodeHarbor URL'}\n`);
    process.exitCode = 1;
  }
}
