# Truce project plan

Status snapshot: 25 October 2026.

## Purpose

Truce is a proposed collaboration workspace for competing AI labs. Each lab should be able to approve a narrowly defined computation over private evidence, receive agreed results, and record approvals and payments through Solana. The other participant should not receive a copy of the underlying dataset.

The motivating example is two rival AI companies learning from their different model failures. The hackathon demonstration will use fictional labs and synthetic data. OpenAI and Anthropic are examples of the intended problem, not participating partners.

Official entry: **Build Track**, focused on AI research workflows and AI x Solana applications. Track judging and the live points race are separate.

## Repository and deployment

- Repository: https://github.com/max1vol/truce
- Production application: https://truce-seven.vercel.app
- Vercel project: https://vercel.com/max1vols-projects/truce
- Production branch: `main`
- Local checkout: the `truce` directory in this workspace.

Production runs on Vercel. Publishing changes to `origin/main` triggers the Git integration. No tunnel or continuously running laptop is needed for the public app. Local development remains optional.

## Current implementation and verified results

Implemented:

- Next.js 16 application and initial project interface.
- Server-side ASRP/1 authentication with `AGENT_STUDIO_VERIFIER_TOKEN`.
- Health endpoint at `/agent-studio/v1/health`.
- Task endpoint at `/agent-studio/v1/tasks`, including request validation, nonce handling and error envelopes.
- OpenAI Responses integration for authenticated `respond` tasks.
- Model-selected read-only `lookup_record` and `exchange_rate` calls for `use_tools`, with real tool results and structured output.
- Bounded retries, time and call budgets, exact organiser URL restrictions, credential isolation and response size limits.
- Explicit unavailable responses for task capabilities that have not been implemented.
- Solana devnet wallet generation using `@solana/kit`.
- Private wallet storage in the ignored `.env.local` file, with restricted permissions.
- Public wallet configuration on the Vercel application.
- Fixed-devnet USDC payment workflows with exact recipient, amount and memo checks, a 0.05 test-USDC transfer cap and a 0.10 test-USDC cumulative cap.
- A private Blob journal persists signed bytes and reserves budget before broadcasting. Retries reuse the recorded transaction; confirmed results survive later status-update failures.

Verified on the event platform:

- Truce is entered in the race.
- The Build Track idea draft has a title, problem statement and repository link.
- The organiser's connection test reached the app and received its authenticated health response.
- Idea locked in passed: 50 points.
- App live passed: 150 points.
- AI feature working passed: 200 points. Fresh arithmetic, instruction following, health and nonce checks all passed on the first attempt.
- Agent uses tools passed: 300 points. The organiser recorded both lookups and the exchange-rate call, verified the computed total and checked the reported results on the first attempt.
- Agentic end-to-end payment passed: 400 points. The organiser confirmed the devnet transfer, amount, recipient and attempt-specific memo.
- App live receipt: `1735AD7F`.
- AI feature working receipt: `82198361`.
- Agent uses tools receipt: `3A0FA0EA`.
- Agentic end-to-end payment receipt: `872A63DC`.
- AI and tool deployment: commit `f8b7f0f` on `main`, verified on 25 October 2026.
- Payment deployment: commit `139f967` on `main`, verified on 25 October 2026.
- Operation Found it passed: 30 points, receipt `FA9D1FE3`.
- Operation Exact passed: 50 points, receipt `243A0C94`.
- Operation Verified passed: 70 points, receipt `C58AB771`.
- Minesweeper Minted passed: 90 points, receipt `037B7F6B`.
- Minesweeper Presented passed: 80 points, receipt `CDF7D583`.
- Minesweeper Fast hands passed: 30 points, receipt `8465D274`.
- All six optional challenges passed in order on their first verification attempts. Operation used the exact 8,929 test-CRED base-unit fee with its matching memo. Minesweeper minted at slot `515040156` and presented at slot `515040161`, a five-slot interval within the 150-slot limit.
- Last verified total: **1,450 points**.

Not implemented or not verified:

- Other task capabilities beyond the supported responses, read-only tools and specific devnet payment workflow.
- Private data collaboration, confidential computing, model training or joint evaluation.
- A final Build Track submission.
- Independent confirmation that the event platform persisted the wallet registration.

### Event team page issue

The wallet form acknowledged a successful save, but the team page displayed empty project fields when reopened. The same display issue affected the app URL even though the race verifier subsequently reached that URL and passed App live.

The public platform source reads several project columns on the team page and ignores the query error. The race separately reads `endpoint_url`. This supports a team-page read/display issue, but its precise cause has not been established. Do not treat blank fields alone as proof that the app registration was lost. Do not repeatedly clear, replace or rotate the existing wallet in response to that display issue.

The current devnet public address is:

```text
7AJR4EctSfeuRrb3YwsVnqRZDJpCDrWRrwYd24EPRSq3
```

Explorer: https://explorer.solana.com/address/7AJR4EctSfeuRrb3YwsVnqRZDJpCDrWRrwYd24EPRSq3?cluster=devnet

The private key must never be committed or copied into this document.

## Immediate priority: remaining race milestones

The user has asked to focus on connecting and verifying the application before pursuing training or the larger privacy research prototype.

Keep the completed Build Track submission as an editable draft, as the user explicitly requested. Do not submit it without a new instruction. All six optional challenges are complete.

The remaining core milestone is Submitted, worth 200 points. The user wants to edit the entry before final submission. All required Build Track fields are saved, accurately separating implemented infrastructure from planned confidential collaboration and training.

The optional Operation and Minesweeper challenges awarded 350 points in total. They used the existing registered wallet and devnet test CRED; no application endpoint changes were needed. Their completion is separate from the Truce product demonstration.

### Step 1: connect a real model

- Completed and verified live. The deployment uses OpenAI Responses with `gpt-5-mini` by default and a server-side production secret. Fresh arithmetic and uppercase checks also pass locally.
- The fastest route is an existing model API connection. Hosting an open model on Modal is another option using the available compute credits.
- Implement the `respond` handler, passing `task.input` to the model and returning its answer in `output.text`.
- Preserve the ASRP/1 envelope and the exact incoming nonce.
- Keep model credentials server-side and out of the public source and browser bundle.
- Handle model errors and timeouts honestly. Do not replace unavailable model calls with canned successful answers.
- Verify using fresh local inputs, publish to `main`, then run the live milestone check.

Training is not required for this milestone.

### Step 2: implement real tool use

- Completed and verified live. The implementation supports model-selected calls to the organiser's read-only lookup and exchange-rate tools. Mutating tools remain unavailable until workflow spending controls are implemented.
- Fourteen offline tests cover actual tool-loop wiring, credential isolation, transient recovery, deadlines, call limits, unsafe endpoints and aggregate response bounds. A separate live model check used synthetic tool data before the official live verification.
- Accept the tool definitions supplied in `task.tools`.
- Let the agent choose the relevant supplied tools and arguments.
- Call their URLs with `task.challengeToken` as the Bearer credential.
- Use the returned data in the answer and include appropriate tool results in the output.
- Respect tool-call counts and timeout limits.
- Add bounded retries for transient failures and return protocol errors when a dependency remains unavailable.
- Constrain outbound requests to the intended task tool service and prevent access to private or local network destinations.
- Never invent tool responses. The organiser records calls independently.

Our eventual product tools and the organiser's verification tools are different integrations. Supporting one does not establish support for the other.

### Step 3: implement devnet payments

- Completed and verified live. The original dedicated wallet was restored and received 20 devnet USDC from Circle. Two 0.01 test-USDC transfers settled during verification, with 0.02 test USDC reserved in the journal. The first settled transfer exposed a compressed-response ETag issue, which was fixed before the successful verification.
- Fifteen offline payment tests cover actual ephemeral signing, exact devnet mint/amount/memo, concurrent requests, cumulative limits, uncertain broadcasts, missing or weak ETags, storage failures and retry behavior. The RPC and token mint are fixed to devnet; these are test-token transfers.
- Retain the existing dedicated test wallet.
- Confirm event-platform wallet registration where required, accounting for the team-page display issue.
- Fund it with devnet SOL for fees and devnet USDC for transfers.
- Add the private signing key to the intended production environment only when the signing implementation is ready. The initial deployment currently needs only the public address.
- Implement `run_workflow` payment handling for the requested recipient, USDC amount and memo.
- Use the official starter's `payUsdc` helper as an implementation reference, or implement the equivalent with compatible Solana Kit APIs.
- Enforce devnet, validate the requested transfer and apply explicit spending limits.
- Make retries safe: bind the workflow to its task identity and avoid paying twice after a timeout or repeated request. Keep any necessary execution records outside transient function memory.
- Return `{ "signature": "..." }` in `output.data` after the transaction is confirmed.
- Verify the transfer through the organiser's onchain check.

The race payment test asks for a direct transfer. An x402 paid API can be useful for the product, but is not a substitute for that exact test.

### Step 4: complete the final submission

The Build Track form requires:

- Project title.
- Problem solved.
- Project description.
- Code repository.
- Technical architecture.
- AI capabilities and evidence that they work.

Include the production demo link and suitable supporting material. Describe implemented features accurately and identify simulated or planned elements. Submit only once the entry represents the actual project and retain the receipt code.

Check the submission deadline separately from the race countdown. Earlier verified form text listed 18:30 for track submission, while the race showed 18:46. Organisers may update either deadline.

## Verification protocol in plain language

The organiser runs a remote test client. It contacts our public Vercel backend, sends a test and checks the response.

1. The team page supplies the app URL and a verifier token.
2. The health endpoint confirms the application is available.
3. The task endpoint receives a structured request identifying the required capability.
4. The app performs the work and returns an ASRP/1 result.
5. The organiser validates the result and awards points when the milestone passes.

The nonce is a fresh test label. Echoing it means copying the same label into the response so the answer can be matched to the request. It is not evidence by itself that an AI model, tool call, private computation or payment actually occurred.

Both endpoints authenticate `Authorization: Bearer <verifier token>`. The token remains a backend secret. It is not part of the public demo interface.

The protocol guide is the integration reference, but the live race instructions take precedence when organisers change a milestone.

## Proposed product demonstration after the race foundation

This is a proposed scope to validate after the immediate integration work. It is not implemented and does not commit the project to large language model training.

### Small shared safety model

- Lab A contributes synthetic examples of direct prompt injection and benign requests.
- Lab B contributes synthetic examples of malicious instructions embedded in documents or tool results, plus benign examples.
- Train the same small safety classifier using A only, B only and A+B.
- Evaluate all three on a frozen, independently written holdout covering both categories and benign counterexamples.
- Report measured detection performance and false positives. Establish that the experiment works before building a polished results interface.
- Give both labs a restricted prediction endpoint. Keep raw datasets and model weights inside the chosen processing boundary initially.

A CPU classifier is genuine training and is sufficient for the first experiment. LoRA fine-tuning of a small language model is a stretch option. Exchanging a prompt or skill file is a different demonstration: a recipient given the file can read and copy it.

### Intended private job flow

1. Both labs approve a policy identifying the datasets, trainer version, parameters, permitted outputs, price cap and expiry.
2. Each encrypts its dataset to the approved worker.
3. A Solana program or signed job record records approvals and coordinates payment.
4. The worker checks approvals and funding before accessing the data.
5. The worker trains and evaluates the model within the approved processing boundary.
6. Only agreed metrics and restricted prediction access are released.
7. A signed receipt binds the job, input commitments, code version and output hashes. The receipt can be recorded on Solana.

Use opaque job identifiers and suitable salted commitments for private inputs. Keep raw data, secret keys and detailed private results offchain.

## Privacy guarantees and limits

### Solana's role

Standard Solana activity is public. Solana can enforce program-defined approvals and payment rules and record signed statements. It does not automatically make an external server confidential or prove that its training computation was correct.

Confidential Balances protect token amounts and balances. They do not protect arbitrary training datasets. Arcium provides confidential computation with its own trust model and workload constraints. Inco and confidential AI offerings have separate availability and integration requirements. None is assumed to be installed in Truce.

### Ordinary Modal prototype

Modal credits can fund genuine training or inference. Ordinary cloud isolation and encryption in transit or at rest do not establish that the cloud provider or worker operator cannot read plaintext during execution. A Modal prototype must explicitly trust those parties unless a documented confidential execution capability is separately established.

The discussed compute envelope is up to approximately $100 in Modal credits, subject to available account credits and explicit workload limits. No training workload has been run for this plan. Measure a short pilot before estimating a full training run.

### Confidential worker version

To make a stronger claim about protection from infrastructure operators, every stage handling private plaintext must run inside an appropriate attested confidential environment. A small CPU training worker is the simplest proposed version.

Each lab must verify the environment against an approved, pinned worker image before releasing data keys. Use authenticated encrypted ingress, control output and network access, and avoid logging examples. A normal Modal training job followed by confidential inference does not undo the exposure during training.

TEE security depends on hardware, firmware, attestation and the approved software. Attestation identifies the deployed environment; it does not make unsafe application code safe.

### Output leakage

Useful results reveal information. Predictions, statistics, embeddings, gradients and released model weights can expose properties of the contributing data. Restrict outputs and repeated queries, and do not claim that these controls prove zero leakage.

With two participants, exact shared totals can expose the other participant's contribution by subtraction. A formal differential privacy claim requires a defined mechanism and privacy accounting, not just aggregation or an informal addition of noise.

A blockchain receipt establishes the signed record and payment history. It is not automatically a mathematical proof of correct training or secrecy.

## Acceptance criteria and working rules

- Preserve the user's instruction to avoid em dashes and double-hyphen punctuation in authored prose.
- Keep the production branch and Vercel target explicit.
- Keep `.env.local`, signing keys and generated credentials outside Git.
- Use synthetic data for the hackathon demonstration.
- Do not display unimplemented privacy, AI or training features as completed.
- Do not let the public product agent send private examples to an external model API.
- Validate the actual end-to-end flow, including deployment and organiser verification.
- Run TypeScript, the production build and meaningful adapter checks when implementation changes require them. Documentation-only changes do not require repeating unrelated application tests.

## References

- [Live race](https://superteam-agent-studio.vercel.app/race)
- [Team registration](https://superteam-agent-studio.vercel.app/team)
- [Track submission](https://superteam-agent-studio.vercel.app/submit)
- [ASRP/1 verification protocol](https://github.com/Db0706/superteam-agent-studio/blob/main/docs/VERIFICATION_SDK.md)
- [Official starter repository](https://github.com/Db0706/agent-studio-scaffolds)
- [Solana privacy models](https://solana.com/docs/finance/privacy)
- [Solana transactions](https://solana.com/docs/core/transactions)
- [Arcium MPC trust model](https://docs.arcium.com/multi-party-execution-environments-mxes/mpc-protocols)
- [Arcium workload limitations](https://docs.arcium.com/developers/limitations)
- [Modal security](https://modal.com/docs/guide/security)
- [Modal fine-tuning example](https://modal.com/docs/examples/unsloth_finetune)
- [Confidential VM deployment](https://docs.phala.com/phala-cloud/getting-started/start-from-cloud-ui)
- [Attestation verification](https://docs.phala.com/phala-cloud/attestation/verification-guide)
