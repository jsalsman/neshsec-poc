# NESHSEC PoC Agent

## Project overview

This repository contains a **single TypeScript A2A agent service** used for a Native English Speaker Homograph Stress Exemplar Crowdsourcer proof of concept.

The service:
- Exposes A2A JSON-RPC routes via `@a2a-js/sdk`.
- Integrates with **Prolific** to launch/monitor/close a study.
- Serves a participant recording page at `/record`.
- Forwards submitted audio to the backend A2A service (`pronunciation.evaluate`) as native exemplars.

## Tech stack

- Node.js (>= 20)
- TypeScript
- Express
- `@a2a-js/sdk`
- Multer (multipart form uploads)

## Key files

- `src/server.ts`: Main server implementation, A2A executor, Prolific client, backend client, and Express routes.
- `README.md`: Deployment/runtime behavior and environment configuration.

## Commands

- `npm ci`: Install dependencies from lockfile before running build/tests in a fresh environment.
- `npm run build`: Compile TypeScript into `dist/`.
- `npm run start`: Run the compiled server (`dist/server.js`).

## Development conventions

- Keep changes focused on this PoC agent (no SDK-wide architecture assumptions).
- When adding user-visible behavior changes, update `README.md` in the same change.
- Prefer explicit, human-readable errors for configuration issues (especially env vars).
- Preserve compatibility with the existing A2A skill payload format:
  - `study_control`
  - `convergence_status`
  - `submit_exemplar`
