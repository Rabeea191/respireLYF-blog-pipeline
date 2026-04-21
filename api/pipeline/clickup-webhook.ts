// Vercel routes live under /api/, TypeScript source lives under /src/api/.
// This thin wrapper re-exports the real handler so Vercel can pick it up
// at /api/pipeline/clickup-webhook while we keep the implementation in src/.
export { default } from "../../src/api/clickup-webhook";
