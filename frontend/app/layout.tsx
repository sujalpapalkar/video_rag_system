import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Multimodal Intelligence',
  description: 'Local AI Video & Audio Understanding',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
