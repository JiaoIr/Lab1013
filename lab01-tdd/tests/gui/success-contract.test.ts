import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGuiServer } from "../../src/harness/gui-server.js";
import { controls, fillRegistration, submitRegistration, successFeedback } from "../../src/testing/course-gui-test-support.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

describe("fixed classroom success contract", () => {
  it("rejects static headings and accepts only the fixed live status", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<h1>Account created</h1><h2>Registered accounts on this device</h2><p role="status"></p>');
      expect(await successFeedback(page).count()).toBe(0);
      await page.locator('p').evaluate(element => { element.textContent = "Account created."; });
      expect(await successFeedback(page).isVisible()).toBe(true);
      await page.locator('p').evaluate(element => { element.textContent = "Success!"; });
      expect(await successFeedback(page).count()).toBe(0);
    } finally { await page.close(); }
  });

  it("keeps entered values after success and clears success on a rejected next submission", async () => {
    const server = await startGuiServer({ htmlPath: resolve("tests/validation/fixtures/gui-good.html") });
    const page = await browser.newPage();
    try {
      await page.goto(server.url);
      expect(await page.getByRole("status", { includeHidden: true }).textContent()).toBe("");
      await fillRegistration(page, { dateOfBirth: "2000-02-29" });
      await submitRegistration(page);
      expect(await successFeedback(page).isVisible()).toBe(true);
      expect(await controls(page).username.inputValue()).toBe("Valid_User1");
      expect(await controls(page).password.inputValue()).toBe("Password01");
      expect(await controls(page).dateOfBirth.inputValue()).toBe("2000-02-29");
      expect(await controls(page).terms.isChecked()).toBe(true);
      await submitRegistration(page);
      expect(await page.getByRole("status", { includeHidden: true }).textContent()).toBe("");
      expect(await controls(page).username.getAttribute("aria-invalid")).toBe("true");
    } finally { await page.close(); await server.close(); }
  });

  it("publishes the simplified rules to both implementation and test generation", async () => {
    const [brief, implementation, tests] = await Promise.all([
      "requirements/register_gui.md", "prompts/contracts/gui-implementation.md", "prompts/contracts/gui-tests.md",
    ].map(path => readFile(path, "utf8")));
    for (const source of [brief!, implementation!, tests!]) expect(source).toContain("Account created.");
    expect(implementation).toContain("do not automatically reset or clear the form");
    expect(tests).toContain("do not expect fields to be cleared");
  });
});
