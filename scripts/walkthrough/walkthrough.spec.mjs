// M2 exit: a person who does not code puts a folder online, sees it running
// and its output, and survives a broken version — using only the dashboard,
// plus the one command the dashboard tells them to paste on their server.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const TESTBED = process.env.TESTBED ?? 'vdeploy-test-dind';
const SSH = process.env.TESTBED_SSH ?? '';
const password = `walkthrough ${randomBytes(8).toString('hex')}`;

/** What the person does in their provider's web console: paste a command on the server. */
function onServer(command) {
  const quoted = command.replace(/'/g, `'\\''`);
  const inside = `docker exec -i ${TESTBED} sh -c '${quoted}'`;
  const [bin, args] = SSH ? ['ssh', ['-o', 'BatchMode=yes', SSH, inside]] : ['sh', ['-c', inside]];
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 16 << 20 });
}

/** A small app in a folder, as someone might have it on their desktop. */
function appArchive(name, source) {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-'));
  const app = join(dir, name);
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', scripts: { start: 'node server.js' } }),
  );
  writeFileSync(join(app, 'server.js'), source);
  const archive = join(dir, `${name}.tar.gz`);
  // Relative paths: GNU tar reads a drive letter (C:) as a remote host.
  execFileSync('tar', ['-czf', `${name}.tar.gz`, '-C', name, '.'], { cwd: dir });
  return archive;
}

const HELLO = `require('node:http')
  .createServer((req, res) => res.end('Hello from my folder'))
  .listen(process.env.PORT, () => console.log('Listening, ready for visitors'));
`;
const BROKEN = `if (!process.env.DATABASE_URL) {
  console.error('Environment variable DATABASE_URL is not set');
  process.exit(1);
}
`;

/** Answers the password prompt when a change asks for it. */
async function confirmIfAsked(page) {
  const prompt = page.getByRole('dialog', { name: "Confirm it's you" });
  try {
    await prompt.waitFor({ timeout: 4000 });
  } catch {
    return;
  }
  await prompt.getByLabel('Password').fill(password);
  await prompt.getByRole('button', { name: 'Confirm' }).click();
  await expect(prompt).toBeHidden();
}

test('a non-coder puts a folder online and survives a broken version', async ({ page }) => {
  // First visit: VDeploy asks for its owner.
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Your name').fill('Sam');
  await page.getByLabel('Email').fill('sam@walkthrough.invalid');
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Organization name').fill('Sam’s shop');
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('link', { name: 'Servers' })).toBeVisible({ timeout: 30_000 });

  // Connect the server: one command, pasted in the provider's console.
  await page.getByRole('link', { name: 'Servers' }).click();
  await page.getByRole('button', { name: 'Add a server' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await confirmIfAsked(page);
  const dialog = page.getByRole('dialog', { name: 'Connect your server' });
  const command = (await dialog.locator('pre').textContent())?.trim() ?? '';
  expect(command).toMatch(/^curl -fsSL \S+\/api\/v1\/agent\/install\.sh \| sh -s -- --token \S+$/);
  // The testbed has no systemd: the agent is started by hand after the installer.
  onServer(`${command} --no-service && (nohup vd-agent run > /var/log/vd-agent.log 2>&1 &)`);
  await expect(dialog.getByText('Connected')).toBeVisible({ timeout: 120_000 });
  await page.keyboard.press('Escape');

  // A new project from a folder on the desktop.
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: 'New project' }).click();
  await page.getByRole('radio', { name: /Upload a folder/ }).click();
  await page
    .locator('input[accept=".zip,.tar.gz,.tgz"]')
    .setInputFiles(appArchive('hello-folder', HELLO));
  await expect(page.getByText(/We think this is a Node\.js/)).toBeVisible({ timeout: 600_000 });
  await expect(page.getByLabel('Name')).toHaveValue('hello-folder');
  await page.getByRole('button', { name: 'Create and deploy' }).click();
  await confirmIfAsked(page);
  await expect(page).toHaveURL(/\/projects$/, { timeout: 1_500_000 });
  const row = page.getByRole('listitem').filter({ hasText: 'hello-folder' });
  await expect(row.getByText('Live')).toBeVisible({ timeout: 120_000 });

  // It runs, and what it prints shows live.
  await row.getByRole('link', { name: 'hello-folder' }).click();
  await expect(page.getByRole('heading', { name: 'hello-folder' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Project' })
    .getByRole('link', { name: 'Logs' })
    .click();
  await expect(page.getByRole('log')).toContainText('Listening, ready for visitors', {
    timeout: 60_000,
  });

  // A broken version: it never starts, so the working one keeps serving, and
  // the page says why in words, with what to do.
  const tabs = page.getByRole('navigation', { name: 'Project' });
  await tabs.getByRole('link', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Upload a new version' }).click();
  const upload = page.getByRole('dialog', { name: 'Upload a new version' });
  await upload
    .locator('input[accept=".zip,.tar.gz,.tgz"]')
    .setInputFiles(appArchive('hello-folder', BROKEN));
  await upload.getByRole('button', { name: 'Deploy this version' }).click({ timeout: 600_000 });
  await confirmIfAsked(page);
  // What the page itself says (a notification says it too, briefly).
  const main = page.locator('main');
  await expect(main.getByText('The last change did not go through')).toBeVisible({
    timeout: 900_000,
  });
  await expect(main.getByText(/needs a setting called DATABASE_URL/)).toBeVisible();
  await expect(main.getByText(/The version before it is still serving./)).toBeVisible();
  await expect(main.getByText('Needs a look')).toBeVisible();
});
