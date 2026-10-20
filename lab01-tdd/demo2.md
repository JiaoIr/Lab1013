## Setup
Refer to [demo_setup.md](demo_setup.md) for setup instructions. Ensure that you do so before beginning the demo.
(you may skip this step if you have successfully set up in the previous demo)

# Demo 2: Test-driven Development (TDD) via Vitest and Playwright

## 2.1 Test-Driven Development

### 2.1.1 Bug Report Website

We’ll now switch roles and act as software developers building a bug-report submission website.

Start with this requirement:

```md
# Requirement: Bug Report Form

Build a webpage where users can enter and submit a bug report. After a valid report is submitted, show a confirmation message. If submission fails, show an error message. If the report is empty, show a validation message.
```
**Student task:** A simple version of the website is provided. Run it with:
```bash
npx tsx src/demo2/server.ts
```
Open the webpage in your browser and try submitting a report. The website is already connected to the bug-categorization manual from Demo 1. After you submit a report, it should display the model’s response.

> FYI, to cause a submission to fail, use the keyword: grass, anywhere within the report.

### 2.1.2 Define tests and generate them

Now we’ll write tests for the bug report website. The server in `src/demo2/server.ts` exposes a function `validate_submission` that handles report submissions, and we want to check that it behaves as required.

**Student task:** Open `src/demo2/tests.txt` and write down the test cases you think the application should pass. For each case, consider:

- What input or situation is being tested?
- What result should the application produce?
- How can the test determine whether the result is correct?

> Note again: to test whether a submission fails, we will need to use the keyword 'grass'

Once you’ve written your test requirements, ask an LLM to turn them into executable tests (we save on effort of having to write them manually). Run the test-generation agent with:
```bash
npx tsx src/demo2/generate_tests.ts
```
The generated tests should appear in `src/demo2/generated/`. Compare them with your test requirements:

- Do they check the behavior described in the requirement?
- Did the LLM make assumptions about the interface or expected behavior?
- Are any important cases missing?

To generate a new set of tests, edit `tests.txt` and run the test-generation agent again. **Warning:** Running the agent deletes the previously generated tests and replaces them with its latest output.

### 2.1.3 Debugging

**Student task:** Run these tests with `npx tsx src/demo2/run_tests.ts`. The tests should fail if the required behavior has not been implemented yet. We have intentionally caused one of the tests to fail by failing to implement a feature in our website -- find it and fix it, then run the tests again.

You should refer to the `validate_submission` function in `src/demo2/server.ts` to understand the behavior of the server. The function can return one of three values: `"valid"`, `"invalid"`, or `"failure"`. 

This is the TDD cycle:

1. Write a test for the required behavior.
2. Run it and observe it fail.
3. Implement the behavior.
4. Run the test again and confirm it passes.

> Note: A test to check for valid submission may fail due to Vitest being unable to run the server -- this is an intentional decision to limit the scope of the test.

## 2.2 Playwright

In the previous section, the generated Vitest tests ran in Node.js and sent HTTP requests using `fetch`.

Now we’ll use Playwright to test the website in a real browser, following the same kinds of steps a user would.

### 2.2.1 Introduction to Playwright

Playwright automates a browser so you can test a website through the same actions a user would take.

Open the example Playwright test and follow how it:

- **Sets up preconditions**, such as opening the website.
- **Performs actions**, such as entering a bug report and selecting **Submit**.
- **Checks assertions**, such as confirming that a success message appears.

This example shows the basic structure of a Playwright test and how it checks the website’s behavior in a browser.

**Student task:** One of the tests is unfinished. Use the other tests as examples. Add the browser actions and assertions needed to check the required behavior.

> **Note:** An unfinished test may pass even though it checks nothing. A test only verifies behavior when it performs actions and includes assertions.

### 2.2.2 Run the Tests in a Visible Browser

Playwright can run tests in **headless mode**, where the browser stays hidden, or **headful mode**, where you can watch the browser actions. We’ll use headful mode for this demo. A short delay has been added between actions so you can see what the test is doing; normally, browser tests run much faster.

Run the tests:
```bash
npx tsx src/demo2/run_playwright.ts
```
Watch how Playwright interacts with the page and checks the result. If a test fails, read the error message to identify which action or assertion did not behave as expected.

### Conclusion

Congratulations! You’ve learnt how to use test-driven development to check the website’s server behavior with Vitest and its browser behavior with Playwright.