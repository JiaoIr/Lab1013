## I. Pre-Class Environment Setup

This section supports both macOS and Windows. No command-line version-control tools are required. Install Node.js and TraeCode IDE in order, then open the `1-LLM-Agent-MCP-Agentic-TDD` folder separately in TraeCode.

### Step 1: Install Node.js 24

The Node.js installer also installs the npm package manager required by this lab.

#### macOS

1. Open the [official Node.js download page](https://nodejs.org/en/download) in a browser.
2. Confirm that the page is set to **v24.x.x (LTS)**. Do not select Current or another version.
3. In the prebuilt downloads section, select:
   - Operating system: **macOS**;
   - Processor: choose **ARM64 / Apple Silicon** for a Mac with an M1, M2, M3, M4, or newer Apple chip; choose **x64 / Intel** for an older Intel Mac;
   - Download type: **Installer (`.pkg`)**.
4. When the download is complete, double-click the `.pkg` file.
5. In the installer, click **Continue**, **Agree**, and **Install** in order. Enter your computer password or use Touch ID if prompted.
6. Close the installer after the successful installation message appears.

If you are unsure which chip your Mac uses, click the Apple menu in the upper-left corner of the screen, select **About This Mac**, and check the “Chip” or “Processor” field.

#### Windows

1. Open the [official Node.js download page](https://nodejs.org/en/download) in a browser.
2. Confirm that the page is set to **v24.x.x (LTS)**. Do not select Current or another version.
3. In the prebuilt downloads section, select:
   - Operating system: **Windows**;
   - Processor: choose **x64** for most computers; choose **ARM64** only if you are specifically using Windows on ARM;
   - Download type: **Installer (`.msi`)**.
4. When the download is complete, double-click the `.msi` file. If Windows asks whether to allow the app to make changes to your device, click **Yes**.
5. In the setup wizard, click **Next**, accept the license agreement, and keep the default installation location and components. Do not deselect Node.js, npm, or the option to add Node.js to PATH.
6. Click **Install**, then click **Finish** after installation completes.
7. If your IDE's terminal was open while Node.js was being installed, close it completely and reopen it. Otherwise, the `node` and `npm` commands may not be available immediately.

### Step 2: Open the `1-LLM-Agent-MCP-Agentic-TDD` Folder in TraeCode (or IDE of choice)

> TraeCode download link: https://www.trae.cn/ or https://www.trae.ai/ide/

1. Open TraeCode.
2. Click **File → Open**.
3. Navigate to `Lab 4 (Final) - Agent, TDD, GUI Testing/1-LLM-Agent-MCP-Agentic-TDD`.
4. Select the `1-LLM-Agent-MCP-Agentic-TDD` folder containing `package.json`.
5. Click **Open**.

### Step 3: Check Node.js and npm

1. In the TraeCode top menu, click **Terminal → New Terminal**.
2. Enter the following command in the terminal:

```bash
node -v
```

You should see `v24.x.x`. Then enter:

```bash
npm -v
```

You should see `11.x.x` or a later version.

If the terminal reports that `node` or `npm` cannot be found, fully exit and reopen your IDE first. If the problem persists, run the Node.js installer again and confirm that the default components are selected.

### Step 4: Install the Lab Dependencies

Confirm that the top of the TraeCode file explorer shows **1-LLM-Agent-MCP-Agentic-TDD**, then run the following command in the TraeCode terminal you just opened:

```bash
npm install
```

The first installation may take some time. Installation is complete when the command finishes, the terminal prompt returns, and no red error messages appear. Ordinary warning messages usually do not affect the lab.

### Step 5: Install the Playwright Browser

The GUI experiment uses Playwright to run training tests and instructor validation in a real browser. After `npm install` completes, run the following command in the same terminal:

```bash
npm run setup:browsers
```

This command downloads the version of Chromium compatible with this lab. The first installation may take some time. It is complete when the command exits normally and the terminal prompt returns. You generally do not need to run it again after `npm install`, unless Playwright reports that the browser is missing or the course dependency version has changed.

### Step 6: Configure the Model API

Find `.env.example` in the TraeCode file explorer:

1. Right-click `.env.example` and select **Copy**.
2. Right-click an empty area in the file explorer and select **Paste**.
3. Rename the copied file to `.env`.
4. Open `.env` and fill in the following three settings:

```dotenv
base_url=https://api.arc-bench.com/v1
api_key=replace-with-your-api-key
model=deepseek-v4-flash
```

- `base_url`: The OpenAI-compatible API endpoint for the model service. Keep the default value when using the course service.
- `api_key`: An API key provided by the instructor or obtained by you.
- `model`: The model name used in this lab. See `.env.example` for the available models.

To save the file, use `Command+S` on macOS or `Ctrl+S` on Windows. Do not share your API key, and do not commit a `.env` file containing a real key to Git.

### Step 7: Run the Pre-Class Check

Run the following command in your IDE's terminal:

```bash
npm run doctor
```

The message `[ok]` indicates that the model API is ready for the lab. If an error occurs, send the instructor the complete error output from the terminal before class.

The pre-class setup is complete when all four conditions below are met:

- `node -v` displays `v24.x.x`;
- `npm -v` displays `11.x.x` or a later version;
- `npm run setup:browsers` has successfully installed Chromium;
- `npm run doctor` displays `[ok]`.
