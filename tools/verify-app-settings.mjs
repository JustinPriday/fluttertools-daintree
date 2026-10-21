// Isolated UI interaction check. Native control stand-ins exercise the renderer
// and real file-editing service without changing an installed plugin or app.
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { build } = await import(pathToFileURL(path.resolve(root, "../../Daintree/node_modules/esbuild/lib/main.js")).href);
const { chromium } = await import(pathToFileURL(path.resolve(root, "../../Daintree/node_modules/playwright/index.mjs")).href);
const temp = await mkdtemp(path.join(tmpdir(), "flutter-settings-ui-"));
let browser;
try {
  const app = path.join(temp, "app");
  const sourcePath = path.join(app, "lib/config/app_environment.dart");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "class AppEnvironment {\r\n  static const current = ngrok;\r\n  static const other = ngrok;\r\n}\r\n");
  await build({ entryPoints: [path.join(root, "src/flutter/appSettings.ts")], outfile: path.join(temp, "service.mjs"), bundle: true, platform: "node", format: "esm" });
  const { AppSettingsService } = await import(pathToFileURL(path.join(temp, "service.mjs")).href);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const service = new AppSettingsService({ fs: {
    readFileBytes: (file) => readFile(file),
    mkdir: (directory) => mkdir(directory, { recursive: true }),
    writeFile: async (file, content, { expectedRevision }) => {
      let revision = null;
      try { revision = hash(await readFile(file)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (revision !== expectedRevision) throw new Error("Source changed. Preview again before applying.");
      await writeFile(file, content); return { revision: hash(content) };
    },
  } });
  let active = false;
  const state = async () => { const loaded = await service.load(app); return { ...loaded, statuses: await service.statuses(app, loaded.config), active, watchWarning: null }; };
  await writeFile(path.join(temp, "ui.tsx"), `import React from 'react';
export const Dialog=({open,title,description,children,footer})=>open?<section role="dialog" aria-label={title}><h1>{title}</h1><p>{description}</p>{children}<footer>{footer}</footer></section>:null;
export const Button=({children,onClick,disabled,loading,...props})=><button type="button" onClick={onClick} disabled={disabled||loading} aria-label={props['aria-label']}>{children}</button>;
export const IconButton=({onClick,disabled,...props})=><button type="button" onClick={onClick} disabled={disabled} aria-label={props['aria-label']}>Action</button>;
export const Input=({onValueChange,...props})=><input {...props} onChange={event=>onValueChange(event.target.value)}/>;
export const Select=({options,value,placeholder,onValueChange,disabled,...props})=><select aria-label={props['aria-label']} value={value||''} disabled={disabled} onChange={event=>onValueChange(event.target.value)}><option value="" disabled>{placeholder}</option>{options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>;
export const FormField=({label,description,children})=><label>{label}<small>{description}</small>{children}</label>;
export const Toolbar=({children})=><div>{children}</div>;
export const Callout=({children,role})=><div role={role||'note'}>{children}</div>;
export const EmptyState=({title,description})=><div><h2>{title}</h2><p>{description}</p></div>;
export const SettingsGroup=({children})=><div>{children}</div>;
export const SettingsRow=({label,description,error,control})=><div><h2>{label}</h2><p>{description}</p>{error?<div role="alert">{error}</div>:null}{control}</div>;
`);
  await writeFile(path.join(temp, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{AppSettingsDialog}from ${JSON.stringify(path.join(root, "src/appSettings.react.tsx"))};
const callbacks=new Set();window.electron={plugin:{invoke:async(_plugin,channel,args)=>{const result=await window.invokeFixture(channel,args);if(result.error)throw new Error(result.error);return result.value;},onPanel:(_p,_c,_id,callback)=>{callbacks.add(callback);return()=>callbacks.delete(callback)}}};window.changed=()=>callbacks.forEach(callback=>callback({}));
createRoot(document.getElementById('root')).render(<AppSettingsDialog pluginId="fixture" panelId="fixture" projectName="Fixture app" projectPath={${JSON.stringify(app)}} onClose={()=>{}}/>);`);
  await build({ entryPoints: [path.join(temp, "entry.tsx")], outfile: path.join(temp, "ui.js"), bundle: true, platform: "browser", format: "iife", nodePaths: [path.join(root, "node_modules")], alias: { "@daintreehq/plugin-ui": path.join(temp, "ui.tsx"), "react": path.join(root, "node_modules/react"), "react-dom": path.join(root, "node_modules/react-dom") } });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  page.setDefaultTimeout(10000);
  await page.exposeFunction("invokeFixture", async (channel, args) => {
    try {
      let value;
      if (channel === "appSettings.get") value = await state();
      else if (channel === "appSettings.validate") value = await service.validate(app, args.setting);
      else if (channel === "appSettings.save") { await service.save(app, args.config, args.revision); value = await state(); }
      else if (channel === "appSettings.preview") value = await service.preview(app, args.settingId, args.optionId);
      else if (channel === "appSettings.apply") { if (active) throw new Error("Stop all builds before applying"); await service.apply(app, args.preview); value = await state(); }
      else throw new Error("Unexpected channel: " + channel);
      return { value };
    } catch (error) { return { error: error.message }; }
  });
  await page.setContent('<html><head><style>body{font:14px system-ui}section{max-width:760px}label{display:block;margin:8px}input{display:block;width:80%}button,select{margin:4px}pre{white-space:pre-wrap}</style></head><body><div id="root"></div></body></html>');
  await page.addScriptTag({ path: path.join(temp, "ui.js") });
  await page.getByRole("button", { name: "Add setting", exact: true }).click();
  await page.getByRole("button", { name: "Use server environment example" }).click();
  await page.getByRole("button", { name: "Check setting", exact: true }).click();
  await page.getByText("Current value: ngrok", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Save definition", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Server environment", exact: true });
  await select.waitFor();
  assert.equal(await readFile(sourcePath, "utf8"), "class AppEnvironment {\r\n  static const current = ngrok;\r\n  static const other = ngrok;\r\n}\r\n");
  const loaded = await service.load(app);
  const production = loaded.config.appSettings[0].options.find((option) => option.label === "Production").id;
  await select.selectOption(production);
  await page.getByRole("button", { name: "Apply source change" }).click();
  await page.getByText("Saved to source. Use a full Flutter launch to apply.", { exact: true }).waitFor();
  assert.ok((await readFile(sourcePath, "utf8")).includes("current = production;\r\n  static const other = ngrok;"));
  // External source edits are pulled through the same change subscription.
  await writeFile(sourcePath, (await readFile(sourcePath, "utf8")).replace("current = production", "current = staging"));
  await page.evaluate(() => window.changed());
  await page.getByRole("combobox", { name: "Server environment" }).getByRole("option", { name: "Custom value: staging" }).waitFor({ state: "attached" });
  active = true;
  await page.evaluate(() => window.changed());
  await page.waitForFunction(() => document.querySelector('select[aria-label="Server environment"]')?.disabled);
  active = false;
  await page.evaluate(() => window.changed());
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Server environment"]')?.disabled);
  // A stale preview refuses to overwrite a subsequent editor change.
  await select.selectOption(production);
  await page.getByRole("button", { name: "Apply source change" }).waitFor();
  await writeFile(sourcePath, (await readFile(sourcePath, "utf8")) + "// concurrent edit\n");
  await page.getByRole("button", { name: "Apply source change" }).click();
  await page.getByRole("alert").filter({ hasText: "changed" }).waitFor();
  assert.ok((await readFile(sourcePath, "utf8")).includes("current = staging;"));
  assert.ok((await readFile(sourcePath, "utf8")).includes("// concurrent edit"));
  await page.getByRole("button", { name: "Remove Server environment definition; keep source unchanged" }).click();
  await page.getByRole("heading", { name: "No app settings" }).waitFor();
  assert.ok((await readFile(sourcePath, "utf8")).includes("current = staging;"));
  assert.deepEqual(errors, []);
  console.log("App settings UI fixture passed: add/check/save, preview/apply, source preservation, custom value, active-run blocking, stale preview, removal.");
} finally { await browser?.close(); await rm(temp, { recursive: true, force: true }); }
