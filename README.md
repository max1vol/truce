# Truce

Private collaboration between competing AI labs. A Build Track project for the Oxford and Cambridge AI Race.

## Current release

- Next.js application deployed to Vercel through pushes to `main`.
- Authenticated ASRP/1 health and task endpoints.
- Devnet-only wallet generation and public-address registration.
- Private computation, training and AI task execution are not implemented yet. Valid AI tasks return an explicit unavailable error rather than a fabricated result.

## Development

Use Node.js 22 or newer.

```sh
npm ci
cp .env.example .env.local
npm run wallet
npm run dev
```

Add `AGENT_STUDIO_VERIFIER_TOKEN` from the race team page to `.env.local`. Environment files are ignored by Git. Never commit, paste publicly or use a real-money private key.

`npm run wallet` creates a throwaway devnet wallet in `.env.local`, with restricted file permissions. It prints only the public address. `npm run wallet -- status` checks the balance. Register the public address on the team page.

## Vercel

Import `max1vol/truce` into the intended Vercel workspace, use the Next.js framework preset and `main` production branch. Configure the team verifier token as a server-side production environment variable. Set `AGENT_PUBLIC_KEY` to the test wallet's public address. The initial release does not need the wallet private key on Vercel.

Paste the production origin on the race team page and press **Test connection**, then verify **App live** on the race page. No tunnel is required.

## Verification

```sh
npm run typecheck
npm run build
npm run test:adapter
```

The adapter smoke test expects a running server (default `http://localhost:3000`) and reads `AGENT_STUDIO_VERIFIER_TOKEN` from the process environment. Set `ADAPTER_BASE_URL` for a different origin.

- `GET /agent-studio/v1/health`: authenticated readiness response.
- `POST /agent-studio/v1/tasks`: authenticated validation and ASRP/1 nonce/error envelopes.

Protocol: https://github.com/Db0706/superteam-agent-studio/blob/main/docs/VERIFICATION_SDK.md
