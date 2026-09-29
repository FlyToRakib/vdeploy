// The three M6 screens, in a real browser (§26 M6).
//
// Everything these screens drive is already proved by the API run in
// scripts/e2e.mjs. What is not proved there is that the screens
// themselves render against real data and that their controls reach the
// same operations — which is exactly the kind of thing that is fine in a
// test and broken on the page, because a panel reads a field the API
// stopped sending and shows an empty card instead of an error.
//
// So this opens them: previews and staging on a project's Config screen,
// and Integrations under Settings.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';

const TESTBED = process.env.TESTBED ?? 'vdeploy-test-dind';
const SSH = process.env.TESTBED_SSH ?? '';
const password = `screens ${randomBytes(8).toString('hex')}`;

/** What the person does in their provider's console: paste a command. */
function onServer(command) {
  const quoted = command.replace(/'/g, `'\\''`);
  const inside = `docker exec -i ${TESTBED} sh -c '${quoted}'`;
  const [bin, args] = SSH ? ['ssh', ['-o', 'BatchMode=yes', SSH, inside]] : ['sh', ['-c', inside]];
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 16 << 20 });
}

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

/** A public repository, so previews and staging have something to follow. */
const REPO = 'heroku/node-js-getting-started';

test('the previews, staging and integrations screens, against a real system', async ({ page }) => {
  test.setTimeout(2_400_000);

  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Your name').fill('Sam');
  await page.getByLabel('Email').fill('sam@screens.invalid');
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Organization name').fill('Sam’s shop');
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('link', { name: 'Servers' })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('link', { name: 'Servers' }).click();
  await page.getByRole('button', { name: 'Add a server' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await confirmIfAsked(page);
  const dialog = page.getByRole('dialog', { name: 'Connect your server' });
  const command = (await dialog.locator('pre').textContent())?.trim() ?? '';
  onServer(`${command} --no-service && (nohup vd-agent run > /var/log/vd-agent.log 2>&1 &)`);
  await expect(dialog.getByText('Connected')).toBeVisible({ timeout: 120_000 });
  await page.keyboard.press('Escape');

  // An app that deploys from a repository, which is what both screens need.
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: 'New project' }).click();
  await page.getByRole('radio', { name: /From GitHub/ }).click();
  await page.getByLabel('Public repository').fill(REPO);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Create and deploy' }).click();
  await confirmIfAsked(page);
  // The page waits for the first build before it moves on, and a first
  // build fetches a real repository and compiles it on the server.
  await expect(page).toHaveURL(/\/projects$/, { timeout: 1_500_000 });
  const row = page.getByRole('listitem').filter({ hasText: 'node-js-getting-started' });
  await expect(row.getByText('Live')).toBeVisible({ timeout: 300_000 });
  await row.getByRole('link', { name: 'node-js-getting-started' }).click();
  await page
    .getByRole('navigation', { name: 'Project' })
    .getByRole('link', { name: 'Config' })
    .click();

  // Previews: off, and the sentence that says what turning it on costs.
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'Previews' })).toBeVisible();
  const previewsOn = main.getByLabel('Build a preview for every pull request');
  await expect(previewsOn).not.toBeChecked();
  await previewsOn.check();
  await confirmIfAsked(page);
  // Turning them on is a spec change, so the page waits for it to land.
  await expect(main.getByText('No pull requests are open.')).toBeVisible({ timeout: 600_000 });
  await expect(main.getByText(/Also for pull requests from forks/)).toBeVisible();
  await expect(main.getByText(/A pull request from a fork is somebody else's code/)).toBeVisible();
  await expect(main.getByText(/At most 5 at once/)).toBeVisible();

  // Staging: made from the app, following another branch.
  await expect(main.getByRole('heading', { name: 'Staging' })).toBeVisible();
  await main.getByLabel('Branch it follows').fill('main');
  await main.getByRole('button', { name: 'Make a staging copy' }).click();
  await confirmIfAsked(page);
  await expect(main.getByText('node-js-getting-started-staging')).toBeVisible({
    timeout: 1_800_000,
  });
  await expect(main.getByRole('button', { name: 'Promote to production' })).toBeVisible();

  // Integrations: what a key may call, read before it is allowed.
  await page.getByRole('link', { name: 'Integrations' }).click();
  await expect(main.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible();
  await expect(main.getByText('No integrations')).toBeVisible();
  await main.getByLabel("The integration's manifest").fill(
    JSON.stringify({
      name: 'deploy-bot',
      description: 'Deploys when our build server says a commit is good',
      operations: ['project.list'],
    }),
  );
  await main.getByRole('button', { name: 'Allow it' }).click();
  await confirmIfAsked(page);
  await expect(main.getByText(/Give deploy-bot this key/)).toBeVisible({ timeout: 60_000 });
  await expect(main.getByText('project.list')).toBeVisible();
  // The key is shown once, here, and the screen says so.
  await expect(main.getByText(/It is shown once and never again/)).toBeVisible();
  await expect(main.getByLabel('Key')).toHaveValue(/^vd_/);
  await main.getByRole('button', { name: 'Remove' }).click();
  await confirmIfAsked(page);
  await expect(main.getByText('No integrations')).toBeVisible({ timeout: 60_000 });
});
