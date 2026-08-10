import type { Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { openChecks } from './helpers/source-control-ai-generation'
import { seedPRCommentsSidebarFixture } from './helpers/pr-comments-sidebar-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function visibleTextX(card: Locator, text: string): Promise<number> {
  const textBox = await card.evaluate((element, targetText) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const value = node.textContent ?? ''
      const index = value.indexOf(targetText)
      if (index === -1) {
        continue
      }
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + targetText.length)
      const rect = range.getBoundingClientRect()
      return { x: rect.x }
    }
    return null
  }, text)
  if (!textBox) {
    throw new Error(`visible text not found: ${text}`)
  }
  return textBox.x
}

async function expectOpenTextNotShiftedLeft(
  openCard: Locator,
  conversationCard: Locator,
  openText: string,
  conversationText: string
): Promise<void> {
  const delta =
    (await visibleTextX(openCard, openText)) -
    (await visibleTextX(conversationCard, conversationText))
  // Why: the open rail is a real border, but focused row actions must not scroll content left.
  expect(delta).toBeGreaterThanOrEqual(0)
  expect(delta).toBeLessThanOrEqual(3)
}

test.describe('PR comments sidebar cards view', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('groups open, conversation, and resolved comments in cards layout', async ({ orcaPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage)
    await openChecks(orcaPage, worktreeId)

    const commentsSection = orcaPage.getByText('Comments', { exact: true })
    await expect(commentsSection).toBeVisible({ timeout: 10_000 })

    await expect(orcaPage.getByText('Needs review · 1')).toBeVisible()
    await expect(orcaPage.getByText('Please update this handler before merge.')).toBeVisible()
    await expect(orcaPage.getByText('coderabbitai')).toBeVisible()
    await expect(orcaPage.getByText('LGTM on the overall approach.')).toBeVisible()

    const openThreadCard = orcaPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    const conversationCard = orcaPage.getByTestId('pr-comment-group').filter({
      hasText: 'LGTM on the overall approach.'
    })
    await expect(openThreadCard).toBeVisible()
    await expect(conversationCard).toBeVisible()
    await expect(openThreadCard).toHaveClass(/shadow-xs/)
    await expectOpenTextNotShiftedLeft(
      openThreadCard,
      conversationCard,
      'Please update this handler before merge.',
      'LGTM on the overall approach.'
    )
    await expectOpenTextNotShiftedLeft(openThreadCard, conversationCard, 'coderabbitai', 'bob')

    const resolvedTrigger = orcaPage.getByRole('button', { name: 'Resolved · 1' })
    await expect(resolvedTrigger).toBeVisible()
    await expect(orcaPage.getByText('Already fixed upstream.')).toBeHidden()

    await resolvedTrigger.click()
    await expect(orcaPage.getByText('Already fixed upstream.')).toBeVisible()
    await expect(orcaPage.getByText('Resolved', { exact: true })).toBeVisible()
    await expect(
      orcaPage
        .getByTestId('pr-comment-group')
        .filter({ hasText: 'Already fixed upstream.' })
        .getByRole('button', { name: 'Unresolve', exact: true })
    ).toBeVisible()

    await expect(orcaPage.getByRole('button', { name: /^Add$/ })).toHaveCount(0)
  })

  test('adds and removes thumbs reactions on GitHub comments', async ({ orcaPage }, testInfo) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage)

    const codeRabbitCard = orcaPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    const thumbsUp = codeRabbitCard.getByRole('button', { name: 'Add thumbs up reaction' })
    const thumbsDown = codeRabbitCard.getByRole('button', { name: 'Add thumbs down reaction' })
    await expect
      .poll(
        async () => {
          if ((await thumbsUp.isVisible()) && (await thumbsDown.isVisible())) {
            return true
          }
          await openChecks(orcaPage, worktreeId)
          const checksButton = orcaPage.getByRole('button', { name: /^Checks(?: |$)/ }).first()
          if (await checksButton.isVisible()) {
            await checksButton.click()
          }
          return (await thumbsUp.isVisible()) && (await thumbsDown.isVisible())
        },
        { timeout: 15_000 }
      )
      .toBe(true)

    await orcaPage.screenshot({ path: testInfo.outputPath('reaction-before.png') })
    await thumbsUp.click()
    const selectedThumbsUp = codeRabbitCard.getByRole('button', {
      name: 'Remove thumbs up reaction'
    })
    await expect(selectedThumbsUp).toHaveAttribute('aria-pressed', 'true')
    await expect(selectedThumbsUp).toContainText('1')
    await orcaPage.screenshot({ path: testInfo.outputPath('reaction-after.png') })

    await selectedThumbsUp.click()
    await expect(thumbsUp).toHaveAttribute('aria-pressed', 'false')
    await expect(thumbsUp).not.toContainText('1')
  })

  test('can switch from grouped to chronological timeline order', async ({ orcaPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage)
    await openChecks(orcaPage, worktreeId)

    await expect(orcaPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })
    await orcaPage.getByRole('button', { name: 'Comment display options' }).click()
    await orcaPage.getByRole('menuitemradio', { name: 'Timeline' }).click()

    await expect(orcaPage.getByText('Needs review · 1')).toHaveCount(0)
    await expect(orcaPage.getByText('Already fixed upstream.')).toBeVisible()

    const comments = [
      orcaPage.getByText('Already fixed upstream.'),
      orcaPage.getByText('Please update this handler before merge.'),
      orcaPage.getByText('LGTM on the overall approach.')
    ]
    const positions = await Promise.all(
      comments.map(async (comment) => {
        const box = await comment.boundingBox()
        if (!box) {
          throw new Error(`Comment not visible: ${await comment.textContent()}`)
        }
        return box.y
      })
    )

    expect(positions[0]).toBeLessThan(positions[1])
    expect(positions[1]).toBeLessThan(positions[2])
  })

  test('queues an open thread for the agent from the visible row action and menu fallback', async ({
    orcaPage
  }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage)
    await openChecks(orcaPage, worktreeId)

    await expect(orcaPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })

    const openThreadCard = orcaPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    await openThreadCard.hover()
    const visibleQueueButton = openThreadCard.getByRole('button', { name: 'Queue for agent' })
    await expect(visibleQueueButton).toBeVisible()
    await visibleQueueButton.click()
    await expect(visibleQueueButton).toBeHidden()
    await expect(
      orcaPage.getByRole('button', { name: 'Send 1 queued comments to AI' })
    ).toBeVisible()
    await expect(orcaPage.getByText('Queued', { exact: true })).toBeVisible()

    await orcaPage.getByRole('button', { name: 'Clear queued comments' }).click()
    await expect(
      orcaPage.getByRole('button', { name: 'Send 1 queued comments to AI' })
    ).toBeHidden()
    await openThreadCard.hover()
    await expect(visibleQueueButton).toBeVisible()

    const actionsMenu = openThreadCard.getByRole('button', { name: 'More comment actions' })
    await actionsMenu.evaluate((element) => (element as HTMLElement).focus())
    await actionsMenu.press('Enter')
    const queueMenuItem = orcaPage.getByRole('menuitem', { name: 'Queue for agent' })
    await queueMenuItem.click({ force: true })
    await expect(queueMenuItem).toBeHidden()

    await expect(
      orcaPage.getByRole('button', { name: 'Send 1 queued comments to AI' })
    ).toBeVisible()
    await expect(orcaPage.getByText('Queued', { exact: true })).toBeVisible()

    const queuedCard = orcaPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    const queuedCardBox = await queuedCard.boundingBox()
    const checkboxBox = await orcaPage
      .getByRole('checkbox', { name: 'Select comment' })
      .first()
      .boundingBox()
    if (!queuedCardBox || !checkboxBox) {
      throw new Error('queued card and checkbox must be measurable')
    }
    expect(checkboxBox.x - queuedCardBox.x).toBeGreaterThanOrEqual(8)
  })

  test('keeps open card content aligned while the row menu is open', async ({ orcaPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage)
    await openChecks(orcaPage, worktreeId)

    await expect(orcaPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })
    const openThreadCard = orcaPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    const conversationCard = orcaPage.getByTestId('pr-comment-group').filter({
      hasText: 'LGTM on the overall approach.'
    })

    await openThreadCard.hover()
    const actionsMenu = openThreadCard.getByRole('button', { name: 'More comment actions' })
    await actionsMenu.evaluate((element) => (element as HTMLElement).focus())
    await actionsMenu.press('Enter')
    await expect(orcaPage.getByRole('menuitem', { name: 'Queue for agent' })).toBeVisible()

    await expectOpenTextNotShiftedLeft(
      openThreadCard,
      conversationCard,
      'Please update this handler before merge.',
      'LGTM on the overall approach.'
    )
  })
})
