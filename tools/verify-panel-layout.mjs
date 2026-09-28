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
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: hasLocalChrome ? localChrome : undefined, args: ["--no-sandbox", "--disable-crash-reporter"] });
} catch (error) {
  if (!hasLocalChrome) throw error;
  browser = await chromium.launch({ headless: true });
}
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.setContent(`<!doctype html><style>${styles}</style>
    <div id="frame" style="width:900px;height:640px">
      <div class="ft-root">
        <div class="ft-repo-bar"><div class="ft-mark">F</div><div class="ft-context"><strong>Flutter Tools</strong><span>/worktree</span></div><button class="ft-btn ft-icon">S</button></div>
        <div class="ft-launch-bar"><label class="ft-device-picker"><span>Target</span><select class="ft-select"><option>Pixel</option></select></label><span class="ft-spacer"></span><div class="ft-run-action"><button class="ft-btn ft-icon primary">▶</button><div class="ft-run-popover"><span>ALTERNATE LAUNCH</span><button class="ft-run-option"><span class="ft-release-mark">R</span><span><strong>Install &amp; run release</strong><small>Optimized build · debugging and hot reload unavailable</small></span></button></div></div></div>
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
  async function measureRunMenu(width, height) {
    await page.locator("#frame").evaluate((node, size) => { node.style.width = `${size.width}px`; node.style.height = `${size.height}px`; }, { width, height });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(() => {
      const root = document.querySelector(".ft-root").getBoundingClientRect();
      const menu = document.querySelector(".ft-run-popover").getBoundingClientRect();
      const option = document.querySelector(".ft-run-option").getBoundingClientRect();
      return { menuWidth: menu.width, withinRoot: menu.left >= root.left && menu.right <= root.right && menu.top >= root.top && menu.bottom <= root.bottom, optionHeight: option.height };
    });
  }
  const runMenuNormal = await measureRunMenu(900, 640);
  const runMenuNarrow = await measureRunMenu(340, 240);
  if (![runMenuNormal, runMenuNarrow].every((result) => result.withinRoot && result.menuWidth >= 250 && result.optionHeight >= 40)) {
    throw new Error(`Release launch menu did not remain actionable: ${JSON.stringify({ runMenuNormal, runMenuNarrow })}`);
  }
  if (process.env.FLUTTER_TOOLS_RUN_MENU_SCREENSHOT) {
    await measureRunMenu(700, 300);
    await page.screenshot({ path: process.env.FLUTTER_TOOLS_RUN_MENU_SCREENSHOT });
  }
  await page.locator(".ft-tabs").evaluate((node) => { node.innerHTML = '<button class="ft-tab active">Media</button>'; });
  await page.locator(".ft-pane").evaluate((node) => {
    node.className = "ft-pane ft-media";
    node.innerHTML = Array.from({ length: 3 }, (_, index) => `<article class="ft-media-card recording"><div class="ft-media-placeholder"><strong>MP4 RECORDING</strong><span>0:0${index}</span></div><div class="ft-media-info"><div><strong>Screen recording</strong><span>12:00:0${index}</span></div><div class="ft-media-actions"><button class="ft-btn">Open</button></div></div></article>`).join("");
  });
  async function measureMedia(width, height) {
    await page.locator("#frame").evaluate((node, size) => { node.style.width = `${size.width}px`; node.style.height = `${size.height}px`; }, { width, height });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(() => {
      const pane = document.querySelector(".ft-media");
      const card = document.querySelector(".ft-media-card").getBoundingClientRect();
      const actions = document.querySelector(".ft-media-actions").getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      return { paneHeight: paneRect.height, paneWidth: paneRect.width, cardWidth: card.width, cardHeight: card.height, horizontalOverflow: pane.scrollWidth > pane.clientWidth + 1, cardClipped: card.right > paneRect.right + 1, actionsClipped: actions.bottom > paneRect.bottom + 1 };
    });
  }
  const mediaNormal = await measureMedia(900, 640);
  const mediaNarrow = await measureMedia(380, 640);
  const mediaConstrained = await measureMedia(700, 390);
  const mediaShort = await measureMedia(700, 240);
  if (mediaNormal.paneHeight < 450 || mediaNarrow.cardWidth < 200 || mediaNarrow.horizontalOverflow || mediaNarrow.cardClipped || mediaConstrained.actionsClipped || mediaShort.paneHeight < 110 || mediaShort.cardHeight > mediaShort.paneHeight || mediaShort.actionsClipped) {
    throw new Error(`Media layout did not remain usable: ${JSON.stringify({ mediaNormal, mediaNarrow, mediaConstrained, mediaShort })}`);
  }
  await page.locator(".ft-root").evaluate((node) => {
    node.insertAdjacentHTML("beforeend", `<div class="ft-dialog-backdrop ft-params-backdrop"><section class="ft-params-dialog">
      <header class="ft-params-header"><div><span>RUN CONFIGURATION</span><h2>Launch parameters</h2><p>mobile_app</p></div><button class="ft-param-close">×</button></header>
      <div class="ft-params-summary"><div><strong>2</strong><span>defines set</span></div><p>Compile-time values applied to the next full Flutter launch.</p></div>
      <div class="ft-params-tools"><input class="ft-search ft-param-search" placeholder="Find a name or value…"><button class="ft-btn ft-param-add">＋ Add define</button></div>
      <div class="ft-param-columns"><span>STATE</span><span>NAME</span><span>VALUE</span><span></span></div>
      <div class="ft-param-list"><div class="ft-param-row set"><button class="ft-param-toggle"><i></i><span>Set</span></button><input class="ft-param-input ft-param-key" value="ANALYTICS_LOCAL_TEST"><input class="ft-param-input" value="true"><button class="ft-param-remove">×</button></div><div class="ft-param-row unset"><button class="ft-param-toggle"><i></i><span>Unset</span></button><input class="ft-param-input ft-param-key" value="API_MOCKS"><input class="ft-param-input" value="false"><button class="ft-param-remove">×</button></div></div>
      <footer class="ft-params-footer"><div>Defines are not secret storage.</div><button class="ft-btn">Cancel</button><button class="ft-btn primary ft-param-save">Save parameters</button></footer>
    </section></div>`);
  });
  async function measureParameters(width, height) {
    await page.locator("#frame").evaluate((node, size) => { node.style.width = `${size.width}px`; node.style.height = `${size.height}px`; }, { width, height });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(() => {
      const root = document.querySelector(".ft-root").getBoundingClientRect();
      const dialog = document.querySelector(".ft-params-dialog").getBoundingClientRect();
      const search = document.querySelector(".ft-param-search").getBoundingClientRect();
      const save = document.querySelector(".ft-param-save").getBoundingClientRect();
      const firstRow = document.querySelector(".ft-param-row").getBoundingClientRect();
      return { dialogWidth: dialog.width, dialogHeight: dialog.height, withinRoot: dialog.left >= root.left && dialog.right <= root.right && dialog.top >= root.top && dialog.bottom <= root.bottom, searchVisible: search.height >= 24, rowVisible: firstRow.height >= 28 && firstRow.top < dialog.bottom, saveVisible: save.height >= 24 && save.bottom <= dialog.bottom + 1 };
    });
  }
  const parametersNormal = await measureParameters(760, 560);
  const parametersNarrow = await measureParameters(380, 480);
  const parametersShort = await measureParameters(700, 260);
  if (![parametersNormal, parametersNarrow, parametersShort].every((result) => result.withinRoot && result.searchVisible && result.rowVisible && result.saveVisible)) {
    throw new Error(`Launch parameter editor did not remain actionable: ${JSON.stringify({ parametersNormal, parametersNarrow, parametersShort })}`);
  }
  if (process.env.FLUTTER_TOOLS_LAYOUT_SCREENSHOT) {
    await measureParameters(760, 560);
    await page.screenshot({ path: process.env.FLUTTER_TOOLS_LAYOUT_SCREENSHOT });
  }
  console.log(JSON.stringify({ normal, short, runMenuNormal, runMenuNarrow, mediaNormal, mediaNarrow, mediaConstrained, mediaShort, parametersNormal, parametersNarrow, parametersShort }, null, 2));
} finally {
  await browser.close();
}
