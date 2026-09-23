import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pi Proxy Server — OpenAI & Anthropic compatible gateway",
  description:
    "A Pi-compatible proxy server that forwards OpenAI Chat Completions and Anthropic Messages requests to AgentRouter. Full streaming support, drop-in SDK compatibility.",
  keywords: ["Pi", "proxy", "OpenAI", "Anthropic", "Claude", "AgentRouter", "gateway"],
  authors: [{ name: "Pi Proxy" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Pi Proxy Server",
    description: "OpenAI & Anthropic compatible gateway for AgentRouter",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
