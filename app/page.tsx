import { getSolanaConfig } from "@/lib/solana";

export const dynamic = "force-dynamic";

export default async function Home() {
  const wallet = await getSolanaConfig();
  const adapterConfigured = Boolean(process.env.AGENT_STUDIO_VERIFIER_TOKEN?.trim());

  return (
    <main>
      <header className="header">
        <a className="wordmark" href="/" aria-label="Truce home">truce<span>↗</span></a>
        <span className="event">OXFORD × CAMBRIDGE AI RACE</span>
        <a className="text-link" href="https://github.com/max1vol/truce">View source ↗</a>
      </header>

      <section className="hero" aria-labelledby="title">
        <span className="eyebrow"><span className="dot" /> BUILD TRACK · RESEARCH INFRASTRUCTURE</span>
        <h1 id="title">Shared progress.<br /><em>Private research.</em></h1>
        <p className="intro">A place for competing AI labs to collaborate on safer models, with agreed permissions and a clear record of every job.</p>
        <a className="button" href="https://superteam-agent-studio.vercel.app/race">Open the AI Race <span aria-hidden="true">↗</span></a>
      </section>

      <section className="setup" aria-labelledby="setup-title">
        <div className="section-heading"><h2 id="setup-title">The foundation</h2><span>PROJECT SETUP · 01</span></div>
        <div className="cards">
          <article className="card">
            <span className="number">01 / APPLICATION</span>
            <h3>Public app</h3>
            <p>This is the Truce web application. Production updates are deployed from the repository’s main branch.</p>
            <span className="status">Application online</span>
          </article>
          <article className="card">
            <span className="number">02 / VERIFICATION</span>
            <h3>Race connection</h3>
            <p>The organiser can securely check this app through its ASRP/1 adapter.</p>
            <span className={`status ${adapterConfigured ? "" : "pending"}`}>{adapterConfigured ? "Team token configured" : "Waiting for team token"}</span>
          </article>
          <article className="card">
            <span className="number">03 / SOLANA</span>
            <h3>Devnet wallet</h3>
            <p>A dedicated test wallet for the race. Devnet uses test tokens with no real monetary value.</p>
            {wallet.publicKey && wallet.explorerUrl ? <a className="wallet" href={wallet.explorerUrl} title="View the public wallet on Solana Explorer">{wallet.publicKey.slice(0, 8)}…{wallet.publicKey.slice(-8)} ↗</a> : <span className="status pending">Wallet setup pending</span>}
          </article>
        </div>
      </section>

      <section className="next-step">
        <div><span className="eyebrow">WHAT COMES NEXT</span><h2>Build trust, one working step at a time.</h2></div>
        <p>The current release establishes the app and race connection. Private datasets, confidential computation and AI evaluation are still in development.</p>
      </section>
      <footer><span>TRUCE © 2026</span><a href="https://superteam-agent-studio.vercel.app/team">Team workspace ↗</a><span>SOLANA DEVNET</span></footer>
    </main>
  );
}
