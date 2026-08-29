import { test, expect } from '@playwright/test';

/**
 * Smoke tests for the Agent Management console.
 *
 * These replace Backstage's stock spec, which asserted an "Enter" button and an
 * APIs link this portal does not have — it could only ever fail. What is
 * asserted here is what an operator actually needs to be true after a deploy:
 * the product sidebar renders, the runtime's agents reach the page, and the
 * prompt the runtime loaded is visible.
 */

/**
 * Local dev enables the guest provider, so every page is behind a sign-in gate.
 *
 * The gate is rendered by the app, not the server, so checking `isVisible()`
 * straight after `goto` races the first paint and silently skips the click —
 * every later assertion then fails against the sign-in card rather than the
 * page under test. Wait for the button, then wait for it to go away.
 */
async function signIn(page: import('@playwright/test').Page, path: string) {
  await page.goto(path);
  const enter = page.getByRole('button', { name: 'Enter' });
  await enter.waitFor({ state: 'visible', timeout: 30_000 });
  await enter.click();
  await enter.waitFor({ state: 'detached', timeout: 30_000 });
}

test('the product sidebar renders instead of Backstage default chrome', async ({ page }) => {
  await signIn(page, '/');
  for (const label of ['Overview', 'Agents', 'Manager', 'MCP Servers', 'Permissions', 'Runs']) {
    await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
});

test('agents from the runtime reach the Agents page', async ({ page }) => {
  await signIn(page, '/agents');
  // the workload client id, not the agent id: the id also appears in the hidden
  // <option>s of the status filter, so matching it proves nothing about the table
  await expect(page.getByText('sre-agent-active-directory', { exact: true })).toBeVisible();
});

test('an agent detail page opens and shows the prompt the runtime loaded', async ({ page }) => {
  await signIn(page, '/agents/active-directory');
  await expect(page.getByRole('button', { name: 'Edit prompt' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit prompt' }).click();
  // the body comes from config/prompts/active-directory.md via the runtime
  await expect(page.getByText('Active Directory specialist', { exact: false }).first()).toBeVisible();
});

/**
 * "Edit" used to open the blank Create Agent wizard, which proposed a SECOND
 * agent. The failure was invisible until the generated YAML was read, so what
 * is asserted here is that the wizard arrives carrying this agent's values.
 */
test('Edit agent opens the wizard prefilled from the agent', async ({ page }) => {
  await signIn(page, '/agents/active-directory');
  await page.getByRole('button', { name: 'Edit agent' }).click();

  await expect(page).toHaveURL(/\/agents\/active-directory\/edit$/u);
  const name = page.locator('input[value="active-directory"]');
  await expect(name).toBeVisible();
  // the name is the workload identity root: editable here would mean a new agent
  await expect(name).toHaveAttribute('readonly', '');
  await expect(page.getByText('Edit Active Directory Agent')).toBeVisible();
});

/**
 * The Manager is not in `listSpecialists()`, so the Agents page could never show
 * it — the one Agent deciding which specialist runs was the one an operator
 * could not see. It has its own page because it has no identity or tool access
 * to put in the Agents table's columns.
 */
test('the Manager has a page showing its routing table', async ({ page }) => {
  await signIn(page, '/manager');
  await expect(page.getByText('Routing table', { exact: true })).toBeVisible();

  // the routing table, served by the runtime
  for (const agent of ['active-directory', 'openshift', 'keycloak']) {
    await expect(page.getByText(agent, { exact: true })).toBeVisible();
  }
  // it holds no workload credential, and the page says so rather than blanking it
  await expect(page.getByText('the Manager calls no tool, so it holds no workload credential')).toBeVisible();
});

test('unrouting an agent is previewed as a named routing effect', async ({ page }) => {
  await signIn(page, '/manager');
  // uncheck openshift, then read what the runtime says merging would do
  const row = page.locator('label').filter({ hasText: 'openshift' }).first();
  await row.getByRole('checkbox').uncheck();
  await expect(page.getByText('will be removed')).toBeVisible();

  await page.getByText('Review & Propose', { exact: true }).click();
  await page.getByRole('button', { name: 'Preview YAML' }).click();
  await expect(page.getByText('Routing: openshift stops being reachable through the Manager')).toBeVisible();
});

test('the enabled toggle reflects state and cannot be clicked', async ({ page }) => {
  await signIn(page, '/agents/active-directory');
  const toggle = page.getByTitle('Reflects what Git declares, not what is running. Changing it is a pull request, not a click.');
  await expect(toggle).toBeVisible();
  // lifecycle changes are a pull request; the control must not be actionable
  await expect(toggle).toBeDisabled();
});
