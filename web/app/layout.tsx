import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  title: 'TieWon — Live NFL tie probability',
  description: 'Live, play-by-play probability that an NFL game reaches overtime, plus an interactive scenario simulator.',
  openGraph: {
    title: 'TieWon — Live NFL tie probability',
    description: 'Every snap changes the shape of overtime.',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'TieWon — Every snap changes the shape of overtime.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TieWon — Live NFL tie probability',
    description: 'Every snap changes the shape of overtime.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
