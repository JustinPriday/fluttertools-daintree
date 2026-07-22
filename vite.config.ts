import { daintreePlugin } from "@daintreehq/plugin-vite";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const manifest = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [daintreePlugin()],
  build: {
    lib: { entry: { panel: "src/panel.react.tsx" }, formats: ["es"], fileName: () => `panel-${manifest.version}.js` },
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: true,
  },
});
