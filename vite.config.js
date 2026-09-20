import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// UI lives in ui/, builds to dist/ (served by wrangler pages dev + CF Pages).
export default defineConfig({
  root: "ui",
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "ui/src") }, // shadcn component imports
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
