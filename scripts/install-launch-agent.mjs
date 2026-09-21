// Registers (or removes) a macOS launchd agent that keeps `npm run dev` running at login,
// so the Chrome extension always has localhost:3000 to talk to.
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const label = 'com.recruiter-outreach.app';
const dir = process.cwd();
const agents = join(homedir(), 'Library', 'LaunchAgents');
const plist = join(agents, `${label}.plist`);
const log = join(dir, '.local-data', 'agent.log');
const remove = process.argv.includes('--remove');
const load = process.argv.includes('--load') || remove;
const target = `gui/${userInfo().uid}`;
const launchctl = args => { try { return execFileSync('launchctl', args, { stdio: 'pipe' }).toString(); } catch (error) { return error.stderr?.toString() || error.message; } };

if (remove) {
  launchctl(['bootout', `${target}/${label}`]);
  if (existsSync(plist)) unlinkSync(plist);
  console.log(`Removed ${label}. The app no longer starts at login.`);
  process.exit(0);
}
if (process.platform !== 'darwin') { console.error('The launch agent installer only supports macOS.'); process.exit(1); }
mkdirSync(agents, { recursive: true });
mkdirSync(join(dir, '.local-data'), { recursive: true });
const npm = execFileSync('/bin/zsh', ['-lc', 'command -v npm']).toString().trim();
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>cd ${JSON.stringify(dir)} &amp;&amp; exec ${JSON.stringify(npm)} run dev</string></array>
  <key>WorkingDirectory</key><string>${dir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
writeFileSync(plist, xml);
console.log(`Wrote ${plist}`);
if (load) {
  launchctl(['bootout', `${target}/${label}`]);
  const out = launchctl(['bootstrap', target, plist]);
  console.log(out.trim() || `Loaded ${label}. The app now starts at login and restarts if it stops. Logs: ${log}`);
} else {
  console.log(`To activate it now:\n  launchctl bootstrap ${target} ${JSON.stringify(plist)}\nTo remove later:\n  npm run agent:remove`);
}
