import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The app also imports the agent's shared rate logic from ../src
export default defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react()],
    server: { fs: { allow: [".."] } },
    build: { outDir: "../dist-web", emptyOutDir: true },
});
