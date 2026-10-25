# Truce

Private collaboration between competing AI labs. A Build Track project for the Oxford and Cambridge AI Race.

The agreed roadmap, current verification status and privacy boundaries are recorded in [docs/PLAN.md](docs/PLAN.md).

## Current release

- Next.js application deployed to Vercel through pushes to `main`.
- Authenticated ASRP/1 health and task endpoints.
- Devnet-only wallet generation and public wallet configuration. The event platform acknowledged saving the address, but its team page has a display issue that prevents independent confirmation of persistence.
- Authenticated `respond` tasks use the OpenAI Responses API; `use_tools` tasks let the model call the organiser's read-only lookup and exchange-rate tools and return their real results.
- Private computation, training, payment signing and other task capabilities are not implemented yet. Unsupported tasks return an explicit unavailable error.

## Development

Use Node.js 22 or newer.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Add `AGENT_STUDIO_VERIFIER_TOKEN` from the race team page to `.env.local`. Environment files are ignored by Git. Never commit, paste publicly or use a real-money private key.

Set `OPENAI_API_KEY` in `.env` or `.env.local`. `OPENAI_MODEL` defaults to `gpt-5-mini`. An existing shell variable takes precedence over these files; remove a stale shell value before starting the app. Only authenticated race task input is sent to OpenAI. No private research dataset integration exists.

For a new deployment, `npm run wallet` creates a throwaway devnet wallet in `.env.local`, with restricted file permissions. It prints only the public address. Keep the existing race wallet when continuing this project; its public address is recorded in the plan. `node scripts/wallet.mjs status` checks the balance.

## Vercel

Import `max1vol/truce` into the intended Vercel workspace, use the Next.js framework preset and `main` production branch. Configure `AGENT_STUDIO_VERIFIER_TOKEN` and `OPENAI_API_KEY` as server-side production secrets. Set `AGENT_PUBLIC_KEY` to the existing test wallet's public address. Optionally set `OPENAI_MODEL`; the default is `gpt-5-mini`. The current release does not need the wallet private key on Vercel.

The existing production app is https://truce-seven.vercel.app.

Paste the production origin on the race team page and press **Test connection**, then verify **App live** on the race page. No tunnel is required.

## Verification

```sh
npm run typecheck
npm run test:ai
npm run build
npm run test:adapter
```

The adapter smoke test expects a running server (default `http://localhost:3000`) and reads `AGENT_STUDIO_VERIFIER_TOKEN` from the process environment. Set `ADAPTER_BASE_URL` for a different origin.

The offline AI tests use synthetic model and tool responses and no API quota. Set `ADAPTER_TEST_AI=1` for additional live model checks using fresh arithmetic and uppercase tasks. The server needs a working OpenAI key for those checks.

Tool requests are restricted to the organiser's exact HTTPS challenge endpoints for `lookup_record` and `exchange_rate`. Redirects are refused; tool calls, retries, response sizes and task duration are bounded. Challenge credentials stay out of model prompts. Structured results are checked against the supported task schema before returning them.

- `GET /agent-studio/v1/health`: authenticated readiness response.
- `POST /agent-studio/v1/tasks`: authenticated validation and ASRP/1 nonce/error envelopes.

Protocol: https://github.com/Db0706/superteam-agent-studio/blob/main/docs/VERIFICATION_SDK.md
