import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playwrightEntry = path.resolve(root, "../../Daintree/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
const source = await readFile(path.join(root, "src", "panelStyles.ts"), "utf8");
const styles = source.slice(source.indexOf("`") + 1, source.lastIndexOf("`"));

const localChrome = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : undefined;
const hasLocalChrome = localChrome
  ? await access(localChrome).then(() => true, () => false)
  : false;
const browser = await chromium.launch({ headless: true, executablePath: hasLocalChrome ? localChrome : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.setContent(`<!doctype html><style>${styles}</style>
    <div id="frame" style="width:900px;height:640px">
      <div class="ft-root">
        <div class="ft-repo-bar"><div class="ft-mark">F</div><div class="ft-context"><strong>Flutter Tools</strong><span>/worktree</span></div><button class="ft-btn ft-icon">S</button></div>
        <div class="ft-launch-bar"><label class="ft-device-picker"><span>Target</span><select class="ft-select"><option>Pixel</option></select></label><button class="ft-btn primary">Run</button></div>
        <div class="ft-session-bar"><span class="ft-state running"><i></i>running</span></div>
        <main class="ft-main">
          <div class="ft-tabs"><button class="ft-tab active">Console</button></div>
          <section class="ft-pane"><div class="ft-console-tools"><input class="ft-search"><button>Clear</button></div>
            <div class="ft-console-wrap"><div class="ft-console"><div class="ft-line"><span>12:00</span><span>tool</span><span>Flutter output</span></div></div></div>
          </section>
        </main>
        <footer class="ft-toolchain"><span class="ft-tool-dot ready"></span><strong>Flutter</strong><span>3.44.1</span></footer>
      </div>
    </div>`);

  async function measure(width, height) {
    await page.locator("#frame").evaluate((node, size) => { node.style.width = `${size.width}px`; node.style.height = `${size.height}px`; }, { width, height });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(() => {
      const root = document.querySelector(".ft-root").getBoundingClientRect();
      const wrap = document.querySelector(".ft-console-wrap").getBoundingClientRect();
      const consoleBox = document.querySelector(".ft-console").getBoundingClientRect();
      return { rootHeight: root.height, wrapperHeight: wrap.height, consoleHeight: consoleBox.height };
    });
  }

  const normal = await measure(900, 640);
  const short = await measure(700, 240);
  if (normal.consoleHeight < 420 || short.consoleHeight < 110) {
    throw new Error(`Console viewport did not expand: ${JSON.stringify({ normal, short })}`);
  }
  console.log(JSON.stringify({ normal, short }, null, 2));
} finally {
  await browser.close();
}
