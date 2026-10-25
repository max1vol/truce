import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Truce · Private AI collaboration",
  description: "A workspace for competing AI labs to collaborate on model safety. Oxford and Cambridge AI Race prototype.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
