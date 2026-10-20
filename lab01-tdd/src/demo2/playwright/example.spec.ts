import { expect, test } from "@playwright/test";

// Example Playwright tests for the bug report website.
//
// Each test follows the same three steps: set up the preconditions (open the
// site), perform the actions a user would perform (type a report, click
// Submit), and assert the expected result.

test("a valid report shows a confirmation message", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Bug report").fill("Clicking Save closes the form and my changes are gone.");
  await page.getByRole("button", { name: "Submit report" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Your bug report has been submitted.",
  );
});

test("a report containing grass shows an error message", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Bug report").fill("The page breaks near the grass icon.");
  await page.getByRole("button", { name: "Submit report" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Submission failed. Please try again.",
  );
});

test("an empty report shows a validation message", async ({ page }) => {
  await page.goto("/");
  // TODO: submit an empty report and assert that a validation message appears
  // instead of a confirmation. Use the tests above as examples.
});
