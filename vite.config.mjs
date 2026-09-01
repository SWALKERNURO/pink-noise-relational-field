import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];

export default defineConfig({
  base: process.env.GITHUB_ACTIONS && repositoryName ? `/${repositoryName}/` : "/",
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [
    react(),
    {
      name: "noisecolor-directory-index",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          const [pathname, query = ""] = (request.url || "").split("?");
          if (pathname === "/noisecolor/") request.url = `/noisecolor/index.html${query ? `?${query}` : ""}`;
          next();
        });
      },
    },
  ],
});
