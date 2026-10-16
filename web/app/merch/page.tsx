import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'TieWon Merch — Nobody wins. TieWon wins.', description: 'The TieWon debut collection: Delivered and Nobody Wins tees. Design previews; orders are not open yet.' };

export default function Merch() {
  const products = [
    { id: 'delivered', name: 'Delivered Tee', color: 'Black', shirt: '#17191b', art: '/merch/delivered.svg', description: 'For the beautiful moment the clock hits zero and nobody wins. Oversized TieWon lettering, celebration red and six Taiwan flags.' },
    { id: 'nobody-wins', name: 'Nobody Wins Tee', color: 'Bone', shirt: '#ece7db', art: '/merch/nobody-wins.svg', description: 'The entire philosophy, in four words: nobody wins. TieWon wins. A bold typographic print for the overtime faithful.' },
  ];
  return <main style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 24px 80px' }}>
    <a href="/" style={{ color: 'inherit' }}>← Back to TieWon</a>
    <p style={{ marginTop: 60, letterSpacing: '.2em', fontSize: 12 }}>TIEWON / DEBUT COLLECTION</p>
    <h1 style={{ fontSize: 'clamp(40px,8vw,88px)', lineHeight: .95, margin: '18px 0' }}>NOBODY WINS.<br />EVERYBODY STARES.</h1>
    <p style={{ maxWidth: 540, fontSize: 18, lineHeight: 1.6 }}>For the people cheering for the one result nobody else wants.</p>
    <p style={{ color: '#ad3030', fontWeight: 700 }}>Design previews · Orders are not open yet</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,320px),1fr))', gap: 28, marginTop: 32 }}>
      {products.map(p => <article key={p.id} style={{ border: '1px solid #ccc6bc', padding: 20 }}>
        <svg viewBox="0 0 600 600" role="img" aria-label={`${p.name}, ${p.color} T-shirt design preview`} style={{ width: '100%', background: '#d7d5cf' }}>
          <ellipse cx="300" cy="558" rx="180" ry="15" fill="#000" opacity=".08" />
          <path d="M210 80 L250 68 Q300 110 350 68 L390 80 L485 145 L447 233 L397 211 L408 535 Q300 555 192 535 L203 211 L153 233 L115 145 Z" fill={p.shirt} stroke="#000" strokeOpacity=".2" strokeWidth="2" />
          <path d="M250 68 Q300 130 350 68" fill="none" stroke="#777" strokeOpacity=".4" strokeWidth="8" />
          <image href={p.art} x="210" y="180" width="180" height="225" />
        </svg>
        <p style={{ fontSize: 12, letterSpacing: '.12em' }}>01 / {p.color.toUpperCase()}</p>
        <h2 style={{ fontSize: 30, margin: '8px 0' }}>{p.name}</h2>
        <p style={{ lineHeight: 1.6 }}>{p.description}</p>
        <p style={{ fontSize: 13, opacity: .7 }}>Illustrated mockup. Garment, sizes and price to be confirmed.</p>
        <a href={p.art} download style={{ display: 'inline-block', padding: '12px 18px', background: '#bd292b', color: '#fff', fontWeight: 700 }}>Download vector design</a>
      </article>)}
    </div>
    <p style={{ marginTop: 36 }}>Follow <a href="https://x.com/NFL_TieWon">@NFL_TieWon</a> for TieWatch alerts and collection updates.</p>
    <p style={{ fontSize: 12, opacity: .65 }}>Independent fan project. Not affiliated with the NFL or its teams.</p>
  </main>;
}
