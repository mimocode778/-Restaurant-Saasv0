import { useState } from 'react'
import { ApiError } from './api'

export function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Une erreur inattendue est survenue'
}

// Runs an action, shows "…" while it runs and the error if it fails.
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setBusy(true)
    setError(null)
    try {
      return await work()
    } catch (err) {
      setError(errorText(err))
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

export const ROLE_FR: Record<string, string> = { owner: 'Propriétaire', manager: 'Gérant', waiter: 'Serveur' }

export function dateTime(iso: string | Date): string {
  return new Intl.DateTimeFormat('fr-TN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Tunis' }).format(new Date(iso))
}
