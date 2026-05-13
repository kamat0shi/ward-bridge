import { useState } from 'react'

export function HashRow({
  label,
  hash,
  href,
}: {
  label: string
  hash: string
  href: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(hash)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore — old browsers without clipboard API
    }
  }

  return (
    <div className="hash-row">
      <span className="hash-label">{label}:</span>
      <code className="hash-full">{hash}</code>
      <button type="button" className="ghost mini" onClick={copy}>
        {copied ? 'скопировано' : 'копировать'}
      </button>
      <a className="ghost mini" target="_blank" rel="noopener noreferrer" href={href}>
        explorer
      </a>
    </div>
  )
}
