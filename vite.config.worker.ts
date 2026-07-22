import { daintreePlugin } from "@daintreehq/plugin-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [daintreePlugin({ target: "node" })],
  build: {
    lib: { entry: { index: "src/index.ts" }, formats: ["es"] },
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: { output: { chunkFileNames: "[name].js" } },
  },
});
